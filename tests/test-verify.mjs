/* 第三批：复核 + 环境变量铺种 */
const BASE = process.env.PS_BASE || "http://127.0.0.1:5190";
const MOCK = process.env.PS_MOCK || "http://127.0.0.1:5199";
const out = [];
function rec(id, name, pass, detail) { out.push(pass); console.log((pass ? "PASS " : "FAIL ") + id.padEnd(5) + " " + name + (pass ? "" : "  -> " + String(detail).slice(0, 260))); }
async function req(p, o) { const r = await fetch(BASE + p, o); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, headers: r.headers, text: t, json: j }; }
const jpost = (b) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function mk(e) { const r = await req("/api/profiles", jpost(Object.assign({ name: "t", protocol: "openai", baseUrl: MOCK + "/v1", modelId: "mock" }, e))); return r.json.profile; }
async function del(id) { await req("/api/profiles/" + id, { method: "DELETE" }); }

(async () => {
  {
    const c = await mk({ name: "自定义完整URL", protocol: "custom", baseUrl: MOCK + "/v1/chat/completions", modelId: "mock", params: { bodyTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{user}}"}],"temperature":{{temperature}}}' } });
    const r = await req("/api/relay/" + c.id, jpost({ system: "s", user: "普通内容", stream: false }));
    rec("V1", "自定义模板（正确填法）可转发成功", r.status === 200 && r.text.includes("你好，世界"), r.status + " " + r.text.slice(0, 120));
    const last = await (await fetch(MOCK + "/_last")).json();
    rec("V2", "自定义模板变量被替换进请求体", last && last.body && last.raw.indexOf("{{") === -1, last && last.raw.slice(0, 200));
    await del(c.id);
  }
  {
    // 用户内容含双引号：单独看上游是否收到（会不会 500）
    const c = await mk({ name: "自定义引用", protocol: "custom", baseUrl: MOCK + "/v1/chat/completions", modelId: "mock", params: { bodyTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{user}}"}]}' } });
    const r = await req("/api/relay/" + c.id, jpost({ system: "s", user: '请写"你好"这两个字', stream: false }));
    rec("V3", "自定义模板 + 用户内容含双引号（换成 OpenAI 模板则正常）", r.status === 200, r.status + " " + r.text.slice(0, 140));
    await del(c.id);
  }
  {
    const h = await req("/api/health", { method: "HEAD" });
    rec("V4", "HEAD /api/health 也返回 200（未限制方法）", h.status === 200, h.status);
  }
  {
    const p = await mk({});
    const r = await fetch(BASE + "/api/relay/" + p.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: "s", user: "u", stream: true }) });
    rec("V5", "流式响应带 x-accel-buffering:no（防代理缓冲）", r.headers.get("x-accel-buffering") === "no", r.headers.get("x-accel-buffering"));
    await r.text();
    await del(p.id);
  }
  {
    const p = await mk({});
    const r = await req("/api/relay/" + p.id, jpost({ system: "s", user: "u", stream: false }));
    rec("V6", "带 x-prompt-studio-source 头，值为接口 id", r.headers.get("x-prompt-studio-source") === p.id, r.headers.get("x-prompt-studio-source"));
    await del(p.id);
  }
  {
    // 中文接口名 → 响应头是否仍为 ASCII（历史 bug 回归）
    const p = await mk({ name: "中文名接口", modelId: "mock" });
    const r = await req("/api/relay/" + p.id, jpost({ system: "s", user: "u", stream: false }));
    rec("V7", "中文接口名回归：响应头仍为 ASCII，服务不崩", r.status === 200 && r.headers.get("x-prompt-studio-source") === p.id, r.status);
    await del(p.id);
  }
  const f = out.filter((x) => !x).length;
  console.log("\n第三批：总计 " + out.length + "，通过 " + (out.length - f) + "，失败 " + f);
})().catch((e) => { console.error(e); process.exit(1); });
