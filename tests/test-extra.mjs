/* 第二批：边界 / 并发 / 稳定性 + 共享模块单元测试
 * 用法： PS_BASE=http://127.0.0.1:5190 [PS_ROOT=/path/to/被测项目根] node tests/test-extra.mjs
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const BASE = process.env.PS_BASE || "http://127.0.0.1:5190";
const MOCK = process.env.PS_MOCK || "http://127.0.0.1:5199";
const ROOT = resolve(process.env.PS_ROOT || process.cwd());
const DATA_FILE = resolve(ROOT, "data/profiles.json");
const results = [];
function rec(id, name, pass, detail) {
  results.push({ id, name, pass });
  console.log((pass ? "PASS " : "FAIL ") + id.padEnd(5) + " " + name + (pass ? "" : "  -> " + String(detail).slice(0, 300)));
}
async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const jpost = (b) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function mk(extra) {
  const r = await req("/api/profiles", jpost(Object.assign({ name: "t", protocol: "openai", baseUrl: MOCK + "/v1", modelId: "mock", apiStyle: "chat" }, extra)));
  return r.json.profile;
}
async function del(id) { await req("/api/profiles/" + id, { method: "DELETE" }); }

(async () => {
  /* T. HTTP 方法 / 头 */
  {
    const r = await fetch(BASE + "/", { method: "HEAD" });
    rec("T1", "HEAD / 处理正常（不 500）", r.status === 200 || r.status === 405, r.status);
    try { await r.text(); } catch {}
  }
  {
    const r = await req("/api/profiles", { method: "OPTIONS" });
    rec("T2", "OPTIONS /api/profiles 被拒（405）", r.status === 405, r.status);
  }
  {
    const r = await req("/api/profiles", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "noheader", baseUrl: MOCK + "/v1", modelId: "mock" }) });
    rec("T3", "缺少 JSON content-type 也能解析（宽松）", r.status === 200, r.status + " " + r.text.slice(0, 80));
    if (r.json && r.json.profile) await del(r.json.profile.id);
  }
  {
    // 反斜杠路径穿越
    const r = await req("/js%5C..%5C..%5Cserver.mjs");
    rec("T4", "反斜杠路径穿越不泄露源码", !(r.status === 200 && /createServer/.test(r.text)), r.status);
  }
  {
    const r = await req("/" + "a".repeat(3000));
    rec("T5", "超长 URL 不崩溃", r.status === 404 || r.status === 431 || r.status === 400, r.status);
  }

  /* 稳定性：大量坏请求后服务仍在 */
  {
    for (let i = 0; i < 40; i++) {
      await Promise.all([
        req("/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
        req("/api/relay/nope", jpost({})),
        req("/%zz"),
        req("/api/profiles/../health"),
      ]);
    }
    const h = await req("/api/health");
    rec("T6", "40 轮坏请求并发后服务仍存活", h.status === 200, h.status);
  }
  {
    // 客户端中途断开
    const p = await mk({});
    const ac = new AbortController();
    const pr = fetch(BASE + "/api/relay/" + p.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: "s", user: "u", stream: true }), signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    try { await pr; } catch {}
    await new Promise((r) => setTimeout(r, 400));
    const h = await req("/api/health");
    rec("T7", "客户端中途断开后服务仍存活", h.status === 200, h.status);
    await del(p.id);
  }

  /* 自定义模板与非法 Base URL */
  {
    const c = await mk({ name: "自定义模板", protocol: "custom", baseUrl: MOCK + "/v1/custom", modelId: "mock", params: { bodyTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{user}}"}]}' } });
    const r = await req("/api/relay/" + c.id, jpost({ system: "s", user: "普通内容", stream: false }));
    rec("T8", "自定义模板：正常内容转发成功", r.status === 200 && r.text.includes("你好，世界"), r.status + " " + r.text.slice(0, 100));
    const r2 = await req("/api/relay/" + c.id, jpost({ system: "s", user: '引号"和反斜杠\\ 与 {{braces}}', stream: false }));
    rec("T9", "自定义模板：用户内容含引号/花括号时不应崩（期望友好报错）", r2.status === 200, r2.status + " " + r2.text.slice(0, 160));
    await del(c.id);
  }
  {
    const c = await mk({ name: "坏模板", protocol: "custom", baseUrl: MOCK + "/v1/custom", modelId: "mock", params: { bodyTemplate: "{不是合法JSON" } });
    const r = await req("/api/relay/" + c.id, jpost({ system: "s", user: "u" }));
    rec("T10", "自定义模板语法错误应返回 4xx 而非 500", r.status >= 400 && r.status < 500, r.status + " " + r.text.slice(0, 160));
    await del(c.id);
  }
  {
    const e = await mk({ name: "空BaseUrl", baseUrl: " ", modelId: "mock" });
    const r = await req("/api/relay/" + e.id, jpost({ system: "s", user: "u" }));
    rec("T11", "Base URL 为空时给出可读错误", r.status >= 400 && /Base URL|上游请求失败|地址/.test(r.text), r.status + " " + r.text.slice(0, 160));
    await del(e.id);
  }
  {
    const a = await mk({ name: "anthropic空URL", protocol: "anthropic", baseUrl: "", modelId: "x" });
    const r = await req("/api/profiles/" + a.id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rec("T12", "Anthropic 空 URL 会回退到 anthropic.com（可能误报成功/失败，仅记录）", r.status === 200, r.status + " " + r.text.slice(0, 160));
    await del(a.id);
  }

  /* 磁盘落盘检查 */
  {
    const p = await mk({ name: "落盘检查", apiKey: "sk-disk-check-9999", modelId: "mock" });
    const fs = await import("node:fs");
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const hasPlain = raw.includes("sk-disk-check-9999");
    rec("T13", "磁盘文件中不含明文 Key", !hasPlain, hasPlain ? "发现明文！" : "");
    rec("T14", "磁盘文件中存在密文 scheme 字段", /"scheme"\s*:\s*"(dpapi|base64)"/.test(raw), raw.match(/"scheme"\s*:\s*"[a-z]+"/));
    rec("T15", "落盘后无残留 .tmp 文件", !fs.existsSync(DATA_FILE + ".tmp"), "");
    await del(p.id);
  }

  /* U. 共享模块单元测试 */
  {
    const pe = await import(pathToFileURL(resolve(ROOT, "public/js/prompt-engine.mjs")).href);
    const ad = await import(pathToFileURL(resolve(ROOT, "public/js/adapters.mjs")).href);

    rec("U1", "parseJsonLoose：剥 ```json 围栏", JSON.stringify(pe.parseJsonLoose('```json\n{"a":1}\n```')) === '{"a":1}', JSON.stringify(pe.parseJsonLoose('```json\n{"a":1}\n```')));
    rec("U2", "parseJsonLoose：前后夹带文字也能取到", (pe.parseJsonLoose('这是结果 {"a":1} 完毕') || {}).a === 1, "");
    rec("U3", "parseJsonLoose：正文里先出现花括号会解析失败", pe.parseJsonLoose('提示 {注意} 然后是 {"a":1}') !== null, "返回 null（健壮性缺口）");
    rec("U4", "extractVariables：支持中文/点/连字符", JSON.stringify(pe.extractVariables("{{活动名称}} {{a.b}} {{x-y}}")) === JSON.stringify(["活动名称", "a.b", "x-y"]), JSON.stringify(pe.extractVariables("{{活动名称}} {{a.b}} {{x-y}}")));
    rec("U5", "extractVariables：不匹配空 {{}}", pe.extractVariables("{{}}").length === 0, JSON.stringify(pe.extractVariables("{{}}")));

    // 2026-10-13 整改注记：原用例声明了 tplVars 却忘了把它作为第三个参数传进 body()，
    // 于是它期望的 "X" 没有任何来源，无论怎么改代码都不可能通过 —— 这里补上漏掉的实参（其余一字未动）。
    const tplVars = { 活动名称: "X" };
    const rendered = await ad.adapters.custom.body({ protocol: "custom", modelId: "m", params: { bodyTemplate: '{"c":"{{活动名称}}"}' } }, { system: "", user: "" }, tplVars);
    rec("U6", "自定义模板变量范围与 extractVariables 一致（中文变量可替换）", rendered.c === "X", JSON.stringify(rendered));

    rec("U7", "estimateTokens：空文本为 0", pe.estimateTokens("") === 0, pe.estimateTokens(""));
    rec("U8", "estimateTokens：4 个汉字约 4 token（1.05/字后四舍五入）", pe.estimateTokens("你好世界") === 4, pe.estimateTokens("你好世界"));

    const local = pe.localEnhance({ raw: "帮我写一个 python 脚本读取 csv", target: "general", length: "standard", language: "zh" });
    rec("U9", "离线规则模式：产出结构化提示词", local.prompt.includes("# 目标") && local.prompt.includes("# 自检") && local.analysis.offline === true, local.prompt.length + " 字");
    rec("U10", "离线规则模式：关键词命中代码类", local.analysis.taskType.includes("代码"), local.analysis.taskType);

    const en = pe.localEnhance({ raw: "write a launch email", target: "general", length: "compact", language: "en" });
    rec("U11", "离线规则模式：英文分支", en.prompt.startsWith("# Objective"), en.prompt.slice(0, 40));

    rec("U12", "adapterFor：未知协议回退 openai", ad.adapterFor({ protocol: "zzz" }).id === "openai", "");
    rec("U13", "openai.endpoint：baseUrl 已带 /chat/completions 不重复拼接", ad.adapters.openai.endpoint({ baseUrl: "https://x/v1/chat/completions" }) === "https://x/v1/chat/completions", ad.adapters.openai.endpoint({ baseUrl: "https://x/v1/chat/completions" }));
    rec("U14", "openai.endpoint：baseUrl 为空产生站内相对路径（隐患）", ad.adapters.openai.endpoint({ baseUrl: "" }) === "/chat/completions", ad.adapters.openai.endpoint({ baseUrl: "" }));
    rec("U15", "anthropic.body：max_tokens 默认 4096", ad.adapters.anthropic.body({ modelId: "m", params: {} }, { system: "s", user: "u" }).max_tokens === 4096, "");
    rec("U16", "openai.responses：json 模式写入 text.format", JSON.stringify(ad.adapters.openai.body({ modelId: "m", apiStyle: "responses", params: {} }, { system: "s", user: "u", json: true }).text) === '{"format":{"type":"json_object"}}', "");
    rec("U17", "anthropic.delta：解析 content_block_delta", ad.adapters.anthropic.delta({ type: "content_block_delta", delta: { text: "hi" } }) === "hi", "");
    rec("U18", "extractUsage：Anthropic 流式 message_delta 能给 outputTokens", JSON.stringify(ad.extractUsage({ protocol: "anthropic" }, { type: "message_delta", usage: { output_tokens: 7 } })) === JSON.stringify({ outputTokens: 7, totalTokens: 7 }), JSON.stringify(ad.extractUsage({ protocol: "anthropic" }, { type: "message_delta", usage: { output_tokens: 7 } })));
    rec("U19", "toUpstreamBody：responses 风格 input 结构", Array.isArray(pe.toUpstreamBody({ apiStyle: "responses", model: "m", system: "s", user: "u" }).input), "");
    rec("U20", "TARGETS/LENGTHS 常量完整", pe.TARGETS.length === 7 && pe.LENGTHS.length === 3, pe.TARGETS.length + "/" + pe.LENGTHS.length);
  }

  const fail = results.filter((r) => !r.pass);
  console.log("\n==== 汇总（第二批）====");
  console.log("总计 " + results.length + "，通过 " + (results.length - fail.length) + "，失败 " + fail.length);
  for (const f of fail) console.log("  FAIL " + f.id + " " + f.name);
  process.exit(0);
})().catch((e) => { console.error("异常", e); process.exit(1); });
