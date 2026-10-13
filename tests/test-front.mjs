/* 前端真实模块 + 最小 DOM 桩，跑真实交互（不是复制代码，是 import 原始 app.js / profiles.js）
 *
 * 用法（在「项目根目录」，即含有 public/ 的那一层执行）：
 *   PS_BASE=http://127.0.0.1:5190 node tests/test-front.mjs
 * 可用环境变量：
 *   PS_BASE       被测服务地址，默认 http://127.0.0.1:5190
 *   PS_ROOT       被测项目根目录的绝对路径，默认取当前工作目录
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const BASE = process.env.PS_BASE || "http://127.0.0.1:5190";
const ROOT = resolve(process.env.PS_ROOT || process.cwd());
const APP = pathToFileURL(resolve(ROOT, "public/js/app.js")).href;
const PROF = pathToFileURL(resolve(ROOT, "public/js/profiles.js")).href;

const results = [];
function rec(id, name, pass, detail) { results.push({ id, name, pass }); console.log((pass ? "PASS " : "FAIL ") + id.padEnd(5) + " " + name + (pass ? "" : "  -> " + String(detail).slice(0, 320))); }

/* ---------------- 最小 DOM ---------------- */
function makeEl(sel) {
  const listeners = {};
  const cl = new Set();
  const e = {
    __sel: sel, listeners, dataset: {}, style: {}, attrs: {},
    classList: { add: (c) => cl.add(c), remove: (c) => cl.delete(c), toggle: (c, f) => (f === undefined ? (cl.has(c) ? cl.delete(c) : cl.add(c)) : (f ? cl.add(c) : cl.delete(c))), contains: (c) => cl.has(c) },
    value: "", textContent: "", innerHTML: "", placeholder: "", checked: false, disabled: false, hidden: false,
    scrollTop: 0, scrollHeight: 100, selectionStart: 0, selectionEnd: 0,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {}, setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {}, focus() {}, blur() {}, select() {},
    setSelectionRange() {}, setRangeText() {},
    dispatchEvent(ev) { for (const f of (listeners[ev && ev.type] || [])) f(ev); return true; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    contains() { return false; }, getBoundingClientRect() { return { width: 0, height: 0 }; },
    click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {}, shiftKey: false, metaKey: false, ctrlKey: false }); },
  };
  return e;
}
const registry = new Map();
const doc = {
  querySelector(sel) { if (!registry.has(sel)) registry.set(sel, makeEl(sel)); return registry.get(sel); },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl("<" + tag + ">"); },
  addEventListener() {}, body: makeEl("body"), documentElement: makeEl("html"),
};
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.location = { protocol: "http:", origin: BASE, href: BASE + "/" };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(typeof input === "string" && input.startsWith("/") ? BASE + input : input, init);
globalThis.confirm = () => true;
globalThis.setInterval = () => 0;
globalThis.alert = () => {};
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => { throw new Error("blocked"); } } }, configurable: true });
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:x";

const $ = (s) => doc.querySelector(s);
const click = (sel) => { const el = $(sel); el.dispatchEvent({ type: "click", target: el, preventDefault() {}, stopPropagation() {}, shiftKey: false, metaKey: false, ctrlKey: false }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiProfiles() {
  const r = await realFetch(BASE + "/api/profiles");
  return (await r.json()).profiles;
}
async function clearAll() {
  for (const p of await apiProfiles()) await realFetch(BASE + "/api/profiles/" + p.id, { method: "DELETE" });
}
async function mkServer(name, extra) {
  const r = await realFetch(BASE + "/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ name, baseUrl: "http://127.0.0.1:5199/v1", modelId: "mock", protocol: "openai" }, extra)) });
  return (await r.json()).profile;
}

(async () => {
  const P = await import(PROF);
  await import(APP);
  await sleep(600);

  rec("F1", "boot 后本地服务被识别为可用", P.profileState.available === true, JSON.stringify({ a: P.profileState.available }));
  rec("F2", "boot 后完成首次连接（服务状态不报下线）", ($("#modeChip").textContent || "").length > 0, $("#modeChip").textContent);

  /* 接口表单：保存 */
  await clearAll();
  await P.loadProfiles();
  {
    P.openForm(null);
    $("#pfName").value = "前端建的接口";
    $("#pfBaseUrl").value = "http://127.0.0.1:5199/v1";
    $("#pfModelId").value = "mock";
    click("#pfSave");
    await sleep(500);
    const list = await apiProfiles();
    rec("F3", "表单「保存」能新建接口", list.length === 1 && list[0].name === "前端建的接口", JSON.stringify(list.map((x) => x.name)));
    rec("F4", "保存后表单被关闭", $("#profileForm").hidden === true, $("#profileForm").hidden);
  }
  {
    // 「保存并测试」不放问表单 → 再点一次会不会重复建
    await clearAll();
    await P.loadProfiles();
    P.openForm(null);
    $("#pfName").value = "重复测试";
    $("#pfBaseUrl").value = "http://127.0.0.1:5199/v1";
    $("#pfModelId").value = "mock";
    click("#pfTest");
    await sleep(900);
    click("#pfTest");
    await sleep(900);
    const list = await apiProfiles();
    rec("F5", "「保存并测试」连点两次应只建一条（编辑态未回写）", list.length === 1, "实际新建 " + list.length + " 条：" + list.map((x) => x.name).join(","));
    rec("F6", "「保存并测试」不关闭表单（记录现状）", $("#profileForm").hidden === false, "hidden=" + $("#profileForm").hidden);
  }

  /* 列表渲染与转义 */
  {
    await clearAll();
    await mkServer('<img src=x onerror=alert(1)>', {});
    await P.loadProfiles();
    const html = $("#profileList").innerHTML;
    rec("F7", "接口名做 HTML 转义（防注入）", html.includes("&lt;img") && !html.includes("<img src=x"), html.slice(0, 160));
    rec("F8", "列表渲染出接口条目", html.includes("pf-item"), "");
  }

  /* 选择与模式 */
  {
    await clearAll();
    const a = await mkServer("A");
    const b = await mkServer("B");
    await P.loadProfiles();
    rec("F9", "默认自动选中第一个启用接口", P.selectedProfiles().length === 1, JSON.stringify([...P.profileState.selected]));
    P.setMode("compare");
    rec("F10", "切多模型后选中两个", P.selectedProfiles().length === 2, JSON.stringify([...P.profileState.selected]));
    P.setMode("single");
    rec("F11", "切回单模型只留一个", P.selectedProfiles().length === 1, JSON.stringify([...P.profileState.selected]));
    // 禁用后取消选中
    await realFetch(BASE + "/api/profiles/" + a.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    await P.loadProfiles();
    rec("F12", "禁用后自动移出选中集合", !P.selectedProfiles().some((p) => p.id === a.id), JSON.stringify([...P.profileState.selected]));
    rec("F13", "剩一个可用时仍保持有选中", P.selectedProfiles().length === 1, JSON.stringify([...P.profileState.selected]));
    void b;
  }

  /* 变量页 */
  {
    const state = P.profileState;
    void state;
    // 直接驱动 UI：通过 promptOut 输入事件
    const ed = $("#promptOut");
    ed.value = "为 {{产品名}} 写一段文案，面向 {{人群}}，字数 {{字数}}。";
    ed.dispatchEvent({ type: "input", target: ed });
    await sleep(50);
    const varsHtml = $("#varsOut").innerHTML;
    rec("F14", "变量页列出全部 {{变量}}", varsHtml.includes("产品名") && varsHtml.includes("人群") && varsHtml.includes("字数"), varsHtml.slice(0, 160));
    rec("F15", "字数计量器更新", /字 · ~\d+ tokens/.test($("#meter").textContent), $("#meter").textContent);
  }

  /* 离线规则模式生成（不选任何接口） */
  {
    await clearAll();
    await P.loadProfiles();
    $("#raw").value = "帮我给新品发布会写一封邀请函，发给三年以上的老客户";
    $("#raw").dispatchEvent({ type: "input", target: $("#raw") });
    click("#skipChat");
    await sleep(3000);
    const txt = $("#promptOut").value;
    rec("F16", "无接口时走离线规则模式并出文", txt.length > 100 && txt.includes("# 目标"), txt.length + " 字");
    rec("F17", "离线模式生成后「导出/复制」按钮启用", $("#exportPrompt").disabled === false, "disabled=" + $("#exportPrompt").disabled);
    rec("F18", "离线模式生成后写入历史会话", (store.get("prompt-studio.sessions.v1") || "").includes("邀请函"), (store.get("prompt-studio.sessions.v1") || "").slice(0, 80));
    rec("F19", "离线模式：深度模式的评审/修订阶段标记为跳过", $('.stage[data-stage="critique"]').dataset.state === "skipped", $('.stage[data-stage="critique"]').dataset.state);
  }

  /* 有接口 → 走真实流水线（打到 mock 上游） */
  {
    await clearAll();
    await mkServer("流水线");
    await P.loadProfiles();
    $("#raw").value = "写一封活动邀请函";
    $("#deep").checked = true;
    $("#deep").dispatchEvent({ type: "change", target: $("#deep") });
    click("#skipChat");
    await sleep(6000);
    const txt = $("#promptOut").value;
    rec("F20", "接入接口后端到端生成成功（流式落字）", txt.includes("【撰写版】"), txt.length + " 字 :: " + txt.slice(0, 60));
    rec("F21", "深度模式：评审阶段被标记为完成", $('.stage[data-stage="critique"]').dataset.state === "done", $('.stage[data-stage="critique"]').dataset.state);
    rec("F21b", "深度模式：修订阶段被标记为完成", $('.stage[data-stage="revise"]').dataset.state === "done", $('.stage[data-stage="revise"]').dataset.state);
    rec("F21c", "分析阶段拿到结构化的解析结果（走通 JSON 解析）", ($("#analysisOut").innerHTML || "").includes("品牌活动"), ($("#analysisOut").innerHTML || "").slice(0, 80));
    rec("F22", "深度模式：自评徽标显示且含轮次", !$("#scoreChip").hidden && /自评/.test($("#scoreChip").textContent), $("#scoreChip").textContent + " | " + $("#scoreChip").dataset.band);
    rec("F23", "深度模式：命中「收益不足 0.3 分」停止规则", /收益太低/.test($("#log").textContent), $("#log").textContent);
    // 打分序列 7.0 → 6.0，应回退保留第 1 轮（撰写版）
    rec("F24", "保留最高分版本：回退到第 1 轮（撰写版）", txt.includes("【撰写版】") && !txt.includes("【修订版】"), txt.slice(0, 60));
    rec("F25", "回退时给出中文提示（会被下一条 log 立刻覆盖）", /已回退到第 1 轮/.test($("#log").textContent), $("#log").textContent);
    rec("F26", "自评徽标应与「展示的版本」一致（回退后仍显示最差一轮 6.0 = 不一致）", /自评 7\.0/.test($("#scoreChip").textContent), "徽标=" + $("#scoreChip").textContent + " / 展示的是 7.0 分那一版");
    rec("F27", "自评徽标悬停提示含待改问题", /待改/.test($("#scoreChip").title), $("#scoreChip").title);
  }

  /* 多模型对比 */
  {
    await clearAll();
    await mkServer("对比A");
    await mkServer("对比B");
    await P.loadProfiles();
    P.setMode("compare");
    $("#raw").value = "对比测试";
    click("#skipChat");
    await sleep(5000);
    rec("F28", "多模型模式：生成两个模型的选项卡", $("#modelTabs").innerHTML.split("model-tab").length - 1 >= 2, $("#modelTabs").innerHTML.slice(0, 200));
    rec("F29", "多模型模式：编辑器被隐藏、正文区可见", $("#editorShell").hidden === true && $("#modelBody").hidden === false, "shell=" + $("#editorShell").hidden + " body=" + $("#modelBody").hidden);
  }

  /* 沟通提问流程 */
  {
    await clearAll();
    await mkServer("沟通模型");
    await P.loadProfiles();
    $("#deep").checked = false;
    $("#deep").dispatchEvent({ type: "change", target: $("#deep") });
    $("#raw").value = "给小红书写一篇护肤品种草笔记";
    $("#raw").dispatchEvent({ type: "input", target: $("#raw") });
    $("#promptOut").value = "";
    click("#startChat");
    await sleep(1500);
    rec("F31", "沟通阶段：AI 提出关键问题", /在哪个平台用/.test($("#chatLog").innerHTML), $("#chatLog").innerHTML.slice(0, 140));
    rec("F32", "沟通阶段：展示已收集信息快照", /使用场景/.test($("#chatFacts").innerHTML) && $("#chatFacts").hidden === false, $("#chatFacts").innerHTML.slice(0, 120));
    rec("F33", "沟通阶段：轮次计数更新", /第 1 轮/.test($("#chatRound").textContent), $("#chatRound").textContent);
    rec("F34", "沟通阶段不触发生成（编辑器仍为空）", $("#promptOut").value === "", $("#promptOut").value.slice(0, 40));
    rec("F35", "回答框与生成动作区出现", $("#chatInputWrap").hidden === false && $("#chatActions").hidden === false, JSON.stringify({ i: $("#chatInputWrap").hidden, a: $("#chatActions").hidden }));
    rec("F39", "沟通用模型下拉已填充接口", /沟通模型/.test($("#chatModel").innerHTML), $("#chatModel").innerHTML.slice(0, 120));
    $("#chatAnswer").value = "小红书";
    click("#chatSend");
    await sleep(1500);
    rec("F36", "回答后进入下一轮", /第 2 轮/.test($("#chatRound").textContent), $("#chatRound").textContent);
    rec("F37", "沟通记录里出现用户回答气泡", /bubble-me/.test($("#chatLog").innerHTML), "");
    click("#chatGenerate");
    await sleep(4000);
    rec("F38", "点「生成提示词」后才产出内容", $("#promptOut").value.length > 0, $("#promptOut").value.slice(0, 50));
    click("#chatRestart");
    await sleep(50);
    rec("F40", "「重新开始」清空本次沟通", $("#chatRound").textContent === "还没开始", $("#chatRound").textContent);
  }

  /* 清空输入联动 */
  {
    $("#raw").value = "";
    $("#raw").dispatchEvent({ type: "input", target: $("#raw") });
    await sleep(30);
    rec("F30", "清空需求会清掉当前沟通状态", $("#chatRound").textContent === "还没开始" || $("#chatLog").innerHTML.includes("chat-empty"), $("#chatRound").textContent);
  }

  await clearAll();
  const fail = results.filter((r) => !r.pass);
  console.log("\n==== 前端交互汇总 ====");
  console.log("总计 " + results.length + "，通过 " + (results.length - fail.length) + "，失败 " + fail.length);
  for (const f of fail) console.log("  FAIL " + f.id + " " + f.name);
  process.exit(0);
})().catch((e) => { console.error("harness 异常", e); process.exit(1); });
