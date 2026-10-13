/* Prompt Studio 功能测试脚本（零依赖，Node 22+） */
const BASE = process.env.PS_BASE || "http://127.0.0.1:5190";
const MOCK = process.env.PS_MOCK || "http://127.0.0.1:5199";
const NODE = process.execPath;
const results = [];
function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail: detail === undefined ? "" : String(detail).slice(0, 400) });
  console.log((pass ? "PASS " : "FAIL ") + id.padEnd(5) + " " + name + (pass ? "" : "  -> " + String(detail).slice(0, 300)));
}
async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const jpost = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const jpatch = (body) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function mkProfile(extra) {
  const r = await req("/api/profiles", jpost(Object.assign({ name: "测试接口", protocol: "openai", baseUrl: MOCK + "/v1", modelId: "mock", apiStyle: "chat" }, extra)));
  return r.json && r.json.profile;
}

(async () => {
  /* ---------- A. 静态与路由 ---------- */
  {
    const r = await req("/");
    rec("A1", "GET / 返回首页 HTML", r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && r.text.includes("Prompt Studio"), r.status);
  }
  {
    const r = await req("/js/app.js");
    rec("A2", "GET /js/app.js 返回 JS", r.status === 200 && /javascript/.test(r.headers.get("content-type")), r.headers.get("content-type"));
  }
  {
    const r = await req("/README.md");
    rec("A3", "GET /README.md 可访问（页头「使用说明」链接）", r.status === 200, r.status);
  }
  {
    const r = await req("/does-not-exist.txt");
    rec("A4", "不存在的静态文件返回 404", r.status === 404, r.status);
  }
  {
    const r = await req("/js/../../server.mjs");
    const leaked = r.status === 200 && /createServer/.test(r.text);
    rec("A5", "路径穿越 /js/../../server.mjs 不泄露源码", !leaked, r.status + " " + r.text.slice(0, 60));
  }
  {
    const r = await req("/..%2f..%2f..%2f..%2fWindows%2Fwin.ini");
    const leaked = r.status === 200 && /\[fonts\]|\[extensions\]/i.test(r.text);
    rec("A6", "编码路径穿越不泄露系统文件", !leaked, r.status);
  }
  {
    const r = await req("/%C0%AE%C0%AE/%C0%AE%C0%AE/Windows/win.ini");
    rec("A7", "非法编码路径不崩溃（返回 4xx/5xx 而非挂掉）", r.status >= 400, r.status);
  }
  {
    const r = await req("/%E0%A4%A");
    rec("A8", "URI 解码异常返回结构化错误", r.status === 400 || r.status === 500 || r.status === 404, r.status + " " + r.text.slice(0, 80));
  }
  {
    const r = await req("/api/health");
    rec("A9", "GET /api/health 返回默认配置", r.status === 200 && r.json && r.json.ok === true && !!r.json.defaults, JSON.stringify(r.json && r.json.defaults));
  }
  {
    const r = await req("/api/health", { method: "PUT" });
    rec("A10", "/api/health 非 GET 被拒", r.status === 405, r.status);
  }

  /* ---------- B. 接口配置 CRUD ---------- */
  let p1, p2, p3;
  await req("/api/profiles");
  {
    const r = await req("/api/profiles");
    rec("B1", "GET /api/profiles 返回列表结构", r.status === 200 && Array.isArray(r.json.profiles) && typeof r.json.encryption === "string", JSON.stringify(r.json).slice(0, 120));
  }
  {
    p1 = await mkProfile({ name: "本地模拟", modelId: "mock" });
    rec("B2", "POST 新建接口", !!(p1 && p1.id), JSON.stringify(p1));
    rec("B3", "新建接口默认 hasKey=false", p1 && p1.hasKey === false, p1 && p1.hasKey);
  }
  {
    const r = await req("/api/profiles", jpost({ name: "带密钥", baseUrl: MOCK + "/v1", modelId: "mock", apiKey: "sk-test-abcdef123456" }));
    p2 = r.json.profile;
    rec("B4", "带 apiKey 新建，hasKey=true 且返回掩码", p2.hasKey === true && /…/.test(p2.keyHint || ""), JSON.stringify(p2));
    rec("B5", "响应中不含明文密钥", !r.text.includes("sk-test-abcdef123456"), r.text.slice(0, 120));
  }
  {
    const r = await req("/api/profiles");
    rec("B6", "列表不返回 keyCipher 字段", !r.text.includes("keyCipher"), r.text.slice(0, 120));
    rec("B7", "列表不含明文密钥", !r.text.includes("sk-test-abcdef123456"), "");
  }
  {
    const r = await req("/api/profiles/" + p2.id, jpatch({ enabled: false }));
    rec("B8", "PATCH 禁用接口", r.status === 200 && r.json.profile.enabled === false, JSON.stringify(r.json).slice(0, 120));
  }
  {
    const r = await req("/api/profiles/" + p2.id, jpatch({ name: "改名了" }));
    rec("B9", "PATCH 改名且保留密钥", r.status === 200 && r.json.profile.name === "改名了" && r.json.profile.hasKey === true, JSON.stringify(r.json.profile));
  }
  {
    const r = await req("/api/profiles/" + p2.id, jpatch({ apiKey: "" }));
    rec("B10", "PATCH apiKey 传空串清除密钥", r.status === 200 && r.json.profile.hasKey === false, JSON.stringify(r.json.profile));
  }
  {
    const before = await req("/api/profiles/" + p2.id, jpatch({ params: { temperature: 0.3 } }));
    const after = await req("/api/profiles/" + p2.id, jpatch({ params: { temperature: undefined } }));
    const t = after.json.profile.params && after.json.profile.params.temperature;
    rec("B11", "清空 temperature 应生效（期望被清掉）", t === undefined || t === null, "残留值=" + t);
  }
  {
    const r = await req("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: "{坏JSON" });
    rec("B12", "POST 非法 JSON 返回 400", r.status === 400, r.status + " " + r.text.slice(0, 80));
  }
  {
    const r = await req("/api/profiles/不存在的id", jpatch({ name: "x" }));
    rec("B13", "PATCH 不存在的 id 返回 404", r.status === 404, r.status);
  }
  {
    const r = await req("/api/profiles", { method: "DELETE" });
    rec("B14", "DELETE /api/profiles（无 id）返回 405", r.status === 405, r.status);
  }
  {
    const big = "x".repeat(2 * 1024 * 1024 + 100);
    const r = await req("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "big", baseUrl: "u", note: big }) });
    rec("B15", "超过 2MB 请求体被拒", r.status === 400, r.status + " " + r.text.slice(0, 80));
  }
  {
    p3 = await mkProfile({ name: "待删除", modelId: "mock" });
    const d = await req("/api/profiles/" + p3.id, { method: "DELETE" });
    const g = await req("/api/profiles/" + p3.id, { method: "DELETE" });
    rec("B16", "DELETE 生效，再删返回 404", d.status === 200 && g.status === 404, d.status + "/" + g.status);
  }
  {
    // 并发写入竞态
    await req("/api/profiles");
    const n0 = (await req("/api/profiles")).json.profiles.length;
    await Promise.all([...Array(8)].map((_, i) => req("/api/profiles", jpost({ name: "race" + i, baseUrl: MOCK + "/v1", modelId: "mock" }))));
    const n1 = (await req("/api/profiles")).json.profiles.length;
    rec("B17", "并发 8 次新建后应全部保留", n1 - n0 === 8, "新增 " + (n1 - n0) + " / 期望 8");
    // 清理
    for (const p of (await req("/api/profiles")).json.profiles) {
      if (p.name.startsWith("race")) await req("/api/profiles/" + p.id, { method: "DELETE" });
    }
  }

  /* ---------- C. 连接测试端点 ---------- */
  {
    const r = await req("/api/profiles/" + p1.id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rec("C1", "测试：本地模拟上游连接成功", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  }
  {
    const bad = await mkProfile({ name: "坏Key", modelId: "err-401" });
    const r = await req("/api/profiles/" + bad.id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rec("C2", "测试：上游 401 返回 ok=false 与错误信息", r.status === 200 && r.json.ok === false && /401/.test(r.json.message), JSON.stringify(r.json));
    await req("/api/profiles/" + bad.id, { method: "DELETE" });
  }
  {
    const dead = await mkProfile({ name: "死地址", baseUrl: "http://127.0.0.1:1/v1", modelId: "mock" });
    const r = await req("/api/profiles/" + dead.id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rec("C3", "测试：上游不可达返回 ok=false", r.status === 200 && r.json.ok === false, JSON.stringify(r.json));
    await req("/api/profiles/" + dead.id, { method: "DELETE" });
  }

  /* ---------- D. 按 id 转发 ---------- */
  {
    const r = await req("/api/relay/" + p1.id, jpost({ system: "s", user: "u", stream: false }));
    rec("D1", "非流式转发：拿到上游文本", r.status === 200 && r.text.includes("你好，世界"), r.status + " " + r.text.slice(0, 120));
  }
  {
    const r = await req("/api/relay/" + p1.id, jpost({ system: "s", user: "u", stream: true }));
    const ok = r.status === 200 && r.text.includes("data:") && r.text.includes("[DONE]") && r.text.includes("世界");
    rec("D2", "流式转发：SSE 帧完整透传（含 [DONE]）", ok, r.status + " :: " + r.text.slice(0, 160));
  }
  {
    const r = await req("/api/relay/" + p1.id, jpost({ system: "s", user: "u", stream: false }));
    rec("D3", "转发响应带 x-prompt-studio-source 头", r.headers.get("x-prompt-studio-source") === p1.id, r.headers.get("x-prompt-studio-source"));
  }
  {
    const r = await req("/api/relay/" + p1.id, jpost({ system: "s", user: "u", stream: false }));
    rec("D4", "请求体被适配器改写为 OpenAI messages 结构", r.status === 200, "");
    const last = await (await fetch(MOCK + "/_last")).json();
    const ok = last.path === "/v1/chat/completions" && last.body && Array.isArray(last.body.messages) && last.body.messages[0].role === "system" && last.body.model === "mock";
    rec("D5", "上游实际收到 messages=[system,user] 与 model", ok, JSON.stringify(last.body).slice(0, 200));
  }
  {
    const resp = await mkProfile({ name: "resps", modelId: "mock", apiStyle: "responses", baseUrl: MOCK + "/v1" });
    const r = await req("/api/relay/" + resp.id, jpost({ system: "s", user: "u", stream: false }));
    const last = await (await fetch(MOCK + "/_last")).json();
    rec("D6", "responses 风格打到 /v1/responses 且带 input", last.path === "/v1/responses" && Array.isArray(last.body.input), last.path + " " + JSON.stringify(last.body).slice(0, 160));
    await req("/api/profiles/" + resp.id, { method: "DELETE" });
  }
  {
    const anth = await mkProfile({ name: "anthropic", protocol: "anthropic", baseUrl: MOCK + "/v1", modelId: "claude-x" });
    await req("/api/profiles/" + anth.id, jpatch({ apiKey: "sk-ant-test" }));
    const r = await req("/api/relay/" + anth.id, jpost({ system: "s", user: "u", stream: false }));
    const last = await (await fetch(MOCK + "/_last")).json();
    const ok = last.path === "/v1/messages" && last.headers["x-api-key"] === "sk-ant-test" && !!last.headers["anthropic-version"] && last.body.system === "s";
    rec("D7", "Anthropic 协议：/messages + x-api-key + anthropic-version + system 顶层", ok, JSON.stringify({ p: last.path, k: last.headers["x-api-key"], v: last.headers["anthropic-version"] }).slice(0, 200));
    await req("/api/profiles/" + anth.id, { method: "DELETE" });
  }
  {
    const dis = await mkProfile({ name: "禁用接口", modelId: "mock" });
    await req("/api/profiles/" + dis.id, jpatch({ enabled: false }));
    const r = await req("/api/relay/" + dis.id, jpost({ system: "s", user: "u" }));
    rec("D8", "禁用的接口拒绝转发（400）", r.status === 400, r.status + " " + r.text.slice(0, 120));
    await req("/api/profiles/" + dis.id, { method: "DELETE" });
  }
  {
    const r = await req("/api/relay/p_nope", jpost({ system: "s", user: "u" }));
    rec("D9", "转发不存在的 id 返回 404", r.status === 404, r.status);
  }
  {
    const r = await req("/api/relay/" + p1.id, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rec("D10", "缺少 user 字段时上游报错被透传（非崩溃）", r.status >= 200, r.status + " " + r.text.slice(0, 100));
  }
  {
    const e401 = await mkProfile({ name: "401", modelId: "err-401" });
    const r = await req("/api/relay/" + e401.id, jpost({ system: "s", user: "u" }));
    rec("D11", "上游 401 原样透传状态码与中文错误", r.status === 401 && /无效的 API Key/.test(r.text), r.status + " " + r.text.slice(0, 120));
    await req("/api/profiles/" + e401.id, { method: "DELETE" });
  }
  {
    const e5 = await mkProfile({ name: "500", modelId: "err-500-html" });
    const r = await req("/api/relay/" + e5.id, jpost({ system: "s", user: "u" }));
    rec("D12", "上游 500（HTML 错误页）被包装为 JSON 错误", r.status === 500 && !!r.json.error, r.status + " " + r.text.slice(0, 120));
    await req("/api/profiles/" + e5.id, { method: "DELETE" });
  }
  {
    const bj = await mkProfile({ name: "坏JSON", modelId: "err-badjson" });
    const r = await req("/api/relay/" + bj.id, jpost({ system: "s", user: "u", stream: false }));
    rec("D13", "上游返回非 JSON：原样回传不报错", r.status === 200, r.status + " " + r.text.slice(0, 80));
    await req("/api/profiles/" + bj.id, { method: "DELETE" });
  }
  {
    const ec = await mkProfile({ name: "断连", modelId: "err-close" });
    const r = await req("/api/relay/" + ec.id, jpost({ system: "s", user: "u", stream: false }));
    rec("D14", "上游中途断连返回 502 中文提示", r.status === 502 && /上游请求失败/.test(r.text), r.status + " " + r.text.slice(0, 140));
    await req("/api/profiles/" + ec.id, { method: "DELETE" });
  }
  {
    const r = await req("/api/relay/" + p1.id, { method: "GET" });
    rec("D15", "GET /api/relay/:id 返回 405", r.status === 405, r.status);
  }
  {
    const r = await req("/api/relay", jpost({ baseUrl: MOCK + "/v1", apiStyle: "chat", body: { model: "mock", messages: [{ role: "user", content: "hi" }] } }));
    rec("D16", "遗留 /api/relay（不带 id）可用", r.status === 200 && r.text.includes("你好，世界"), r.status + " " + r.text.slice(0, 100));
  }
  {
    const r = await req("/api/relay", jpost({ baseUrl: "https://api.example.com/v1", apiStyle: "chat", body: { model: "m", messages: [] } }));
    rec("D17", "非本地地址且无 Key 时给出中文缺少 Key 提示", r.status === 400 && /缺少 API Key/.test(r.text), r.status + " " + r.text.slice(0, 160));
  }
  {
    const r = await req("/api/relay", jpost({ baseUrl: MOCK + "/v1", body: null }));
    rec("D18", "缺少 body 字段返回 400", r.status === 400, r.status + " " + r.text.slice(0, 100));
  }

  /* ---------- E. 名称/编码边界 ---------- */
  {
    const cn = await mkProfile({ name: "中文接口名🎉", modelId: "mock" });
    const r = await req("/api/relay/" + cn.id, jpost({ system: "s", user: "中文内容测试", stream: false }));
    rec("E1", "中文接口名 + 中文请求体不触发服务崩溃", r.status === 200, r.status + " " + r.text.slice(0, 80));
    const h = await req("/api/health");
    rec("E2", "服务在处理后仍然存活", h.status === 200, h.status);
    await req("/api/profiles/" + cn.id, { method: "DELETE" });
  }
  {
    const weird = await mkProfile({ name: "x", baseUrl: "not a url", modelId: "mock" });
    const r = await req("/api/relay/" + weird.id, jpost({ system: "s", user: "u" }));
    rec("E3", "非法 Base URL 给出可读错误而非崩溃", r.status >= 400, r.status + " " + r.text.slice(0, 140));
    await req("/api/profiles/" + weird.id, { method: "DELETE" });
  }
  {
    const r = await req("/api/profiles", jpost({ name: "无协议", protocol: "bogus", baseUrl: MOCK + "/v1", modelId: "mock" }));
    rec("E4", "非法 protocol 回退为 openai", r.json.profile.protocol === "openai", JSON.stringify(r.json.profile));
    await req("/api/profiles/" + r.json.profile.id, { method: "DELETE" });
  }
  {
    const r = await req("/api/profiles", jpost({ name: "超长名字" + "字".repeat(200), baseUrl: MOCK + "/v1", modelId: "mock" }));
    rec("E5", "超长名称被截断到 60 字符", r.json.profile.name.length <= 60, r.json.profile.name.length);
    await req("/api/profiles/" + r.json.profile.id, { method: "DELETE" });
  }

  /* ---------- 清理 ---------- */
  for (const p of (await req("/api/profiles")).json.profiles) await req("/api/profiles/" + p.id, { method: "DELETE" });

  const fail = results.filter((r) => !r.pass);
  console.log("\n==== 汇总 ====");
  console.log("总计 " + results.length + "，通过 " + (results.length - fail.length) + "，失败 " + fail.length);
  for (const f of fail) console.log("  FAIL " + f.id + " " + f.name + " -> " + f.detail);
  process.exit(0);
})().catch((e) => { console.error("测试脚本异常", e); process.exit(1); });
