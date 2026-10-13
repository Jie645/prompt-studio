import {
  LENGTHS,
  buildAskCall, buildAnalyzeCall, buildComposeCall, buildCritiqueCall, buildReviseCall,
  ASK_SYSTEM, COMPOSE_SYSTEM,
  localEnhance, parseJsonLoose, extractVariables, estimateTokens,
} from "./prompt-engine.mjs";
import { extractDelta, extractText, extractUsage } from "./adapters.mjs";
import { initProfiles, loadProfiles, profileState, renderProfiles, selectedProfiles, setMode } from "./profiles.js";

const $ = (sel) => document.querySelector(sel);

const DIRECT = location.protocol === "file:";

const state = {
  target: "general",     // 目标运行时已从界面移除，固定为通用助手
  length: "standard",
  language: "zh",        // 输出语言固定中文
  deep: false,
  prompt: "",
  analysis: null,
  critique: null,
  running: false,
  rounds: [],
  stopReason: "",
  varValues: {},
  chat: null,
  sessions: [],
  serverAlive: true,
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const LOG_MAX = 60;
const logLines = [];

/**
 * B5：以前是单行赋值，后写的会把前一行冲掉 —— 「已回退到第 N 轮」这种关键提示用户永远看不到。
 * 现在保留最近 60 条（多行 textContent，CSS 用 pre-line 分行 + 可滚动），关键信息不再被覆盖。
 */
function log(message, kind) {
  const el = $("#log");
  if (!el) return;
  const text = String(message == null ? "" : message).trim();
  if (!text) return;                       // 空消息不再清屏
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const mark = kind === "error" ? "✕" : kind === "ok" ? "✓" : "·";
  logLines.push(mark + " " + stamp + "  " + text);
  while (logLines.length > LOG_MAX) logLines.shift();
  el.textContent = logLines.join("\n");
  el.dataset.state = kind || "";
  el.scrollTop = el.scrollHeight || 0;
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function labelOf(list, id) {
  const found = list.find((x) => x.id === id);
  return found ? found.label : id;
}

function band(score) {
  if (score >= 8) return "high";
  if (score >= 5.5) return "mid";
  return "low";
}

/* ------------------------------------------------------------------ */
/* segmented controls                                                  */
/* ------------------------------------------------------------------ */

function syncLengthSelect() {
  const sel = $("#lengthSel");
  sel.innerHTML = LENGTHS.map((l) => '<option value="' + l.id + '">' + l.label + " · " + l.words + "</option>").join("");
  sel.value = state.length;
  $("#lengthNote").textContent = (LENGTHS.find((l) => l.id === state.length) || LENGTHS[1]).note;
}

/* ------------------------------------------------------------------ */
/* stages                                                              */
/* ------------------------------------------------------------------ */

const STAGES = ["analyze", "compose", "critique", "revise"];

function setStage(name, value) {
  const el = document.querySelector('.stage[data-stage="' + name + '"]');
  if (el) el.dataset.state = value;
}

function resetStages(deep) {
  for (const name of STAGES) {
    const keep = name === "critique" || name === "revise";
    setStage(name, keep && !deep ? "skipped" : "");
  }
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("is-active", panel.dataset.panel === name);
  }
}

/* ------------------------------------------------------------------ */
/* request plumbing                                                    */
/* ------------------------------------------------------------------ */

/** 走本地服务，按接口 id 转发；Key 由服务端解密并注入，浏览器始终拿不到明文 */
async function relay(profile, req) {
  if (DIRECT) {
    throw new Error("多接口模式需要本地服务：请用 node server.mjs 启动后访问 http://127.0.0.1:5178，而不是直接打开文件。");
  }
  try {
    return await fetch("/api/relay/" + encodeURIComponent(profile.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch {
    state.serverAlive = false;
    updateModeChip();
    throw new Error("连不上本地服务（" + location.origin + "）。后台的 node server.mjs 可能已经退出了，重新启动后点右上角「重新连接」。");
  }
}

async function readStream(resp, onDelta, profile, collector) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const usage = extractUsage(profile, json);
      if (usage && collector) collector.usage = { ...(collector.usage || {}), ...usage };
      const delta = extractDelta(profile, json);
      if (delta) { full += delta; onDelta(full); }
    }
  }
  return full;
}

/** 一次模型调用：profile 决定协议与上游地址，其余与原来一致 */
async function runCall(call, onDelta, profile, collector) {
  const target = profile || selectedProfiles()[0];
  if (!target) throw new Error("还没有可用的模型接口。请在左侧「模型接口」里新增一个（或启用已有的）。");
  const resp = await relay(target, {
    system: call.system,
    user: call.user,
    stream: Boolean(call.stream),
    json: Boolean(call.jsonMode),
    vars: state.varValues || {},     // B8：自定义模板里可以用变量页填好的值
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const text = await resp.text();
      try { detail = (JSON.parse(text).error || {}).message || text; } catch { detail = text; }
    } catch {}
    throw new Error("「" + target.name + "」返回 " + resp.status + (detail ? "：" + String(detail).slice(0, 300) : ""));
  }

  if (call.stream) {
    if (!resp.body) throw new Error("接口没有返回流式内容。");
    return await readStream(resp, onDelta || (() => {}), target, collector);
  }
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return extractText(target, json) || text;
}
/* ------------------------------------------------------------------ */
/* pipeline                                                            */
/* ------------------------------------------------------------------ */

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setPrompt(text) {
  state.prompt = text;
  const editor = $("#promptOut");
  if (editor.value !== text) editor.value = text;
  $("#meter").textContent = text.length + " 字 · ~" + estimateTokens(text) + " tokens";
  renderVars();
  applyView();
}

async function typewriter(text, apply) {
  const step = Math.max(6, Math.round(text.length / 60));
  for (let i = 0; i < text.length; i += step) {
    apply(text.slice(0, i + step));
    await tick(18);
  }
  apply(text);
}

function hasKey() {
  return selectedProfiles().length > 0;
}

function markStagesError() {
  for (const name of STAGES) setStage(name, "error");
}

async function generate() {
  if (state.running) return;
  const raw = $("#raw").value.trim();
  if (!raw) {
    log("先在「你的需求」里写一句话。", "error");
    $("#raw").focus();
    return;
  }
  const input = {
    raw,
    target: state.target,
    length: state.length,
    language: state.language,
  };

  const picked = selectedProfiles();
  const compare = profileState.mode === "compare" && picked.length > 1;
  // 没选接口时不报错，退回内置规则模式（离线也能把结构搭出来）
  const online = picked.length > 0;
  state.running = true;
  state.prompt = "";
  state.analysis = null;
  state.critique = null;
  state.rounds = [];
  state.stopReason = "";
  state.varValues = {};
  resetStages(state.deep && online);
  $("#emptyState").hidden = true;
  $("#promptOut").value = "";
  renderAnalysis(null);
  renderScoreChip();
  renderVars();
  setPromptActions(false);
  showTab("prompt");
  saveJson("prompt-studio.draft.v1", input);
  setCompareVisible(compare);

  try {
    if (compare) {
      await generateCompare(input, picked);
      setPromptActions(true);
      return;
    }
    if (!online) {
      log("没有选中的模型接口，先用内置规则模式搭出结构骨架。选好接口后，改由模型完成改写与自评。", "");
      setStage("analyze", "active");
      await tick(260);
      const local = localEnhance(input);
      state.analysis = local.analysis;
      renderAnalysis(state.analysis);
      setStage("analyze", "done");
      setStage("compose", "active");
      await typewriter(local.prompt, setPrompt);
      setStage("compose", "done");
      log("已生成（规则模式）。填好模型接口后，会改由模型完成改写与自评。", "ok");
    } else {
      setStage("analyze", "active");
      const analysisText = await runCall(buildAnalyzeCall(input));
      const analysis = parseJsonLoose(analysisText);
      state.analysis = analysis || { goal: analysisText.slice(0, 400) };
      renderAnalysis(state.analysis);
      setStage("analyze", "done");

      setStage("compose", "active");
      const composed = await runCall(buildComposeCall(input, state.analysis, state.activeChat), setPrompt);
      setPrompt(composed);
      setStage("compose", "done");

      if (state.deep) {
        let current = composed;
        let previousScore = null;
        let stopReason = "";
        let currentScore = null;
        const rounds = [];

        for (let round = 1; round <= MAX_ROUNDS; round += 1) {
          setStage("critique", "active");
          log("第 " + round + " 轮评审中…", "");
          const critiqueText = await runCall(buildCritiqueCall(input, current));
          const critique = parseJsonLoose(critiqueText) || { verdict: critiqueText.slice(0, 600), issues: [] };
          const score = scoreOf(critique);
          currentScore = score;
          // B6：每轮连同「那一版的正文 + 那一轮的评审」一起记下来，
          // 回退时才能把徽标/导出文档同步成被保留那轮的分数。
          rounds.push({
            round, score,
            verdict: critique.verdict || "",
            stopReason: critique.stopReason || "",
            critique,
            prompt: current,
          });
          state.critique = critique;
          state.rounds = rounds;
          renderScoreChip();
          setStage("critique", "done");

          // 停止规则：达标 / 收益太小 / 模型自己说停 / 轮数用尽
          const stop = decideStop({ round, score, previousScore, critique });
          if (stop.stop) { stopReason = stop.reason; break; }
          previousScore = score;

          setStage("revise", "active");
          current = await runCall(buildReviseCall(input, current, critique, round + 1), setPrompt);
          setPrompt(current);
          setStage("revise", "done");
        }

        // 保留得分最高的版本，而不是最后一版
        const best = rounds.reduce((a, b) => (b.score > a.score ? b : a), rounds[0]);
        if (rounds.length) {
          const last = rounds[rounds.length - 1];
          if (best.score > last.score && best.round < last.round) {
            setPrompt(best.prompt);
            state.critique = best.critique;          // B6：徽标与导出文档跟着回到被保留那一轮
            renderScoreChip();
            log("最后一轮反而更差，已回退到第 " + best.round + " 轮（" + best.score.toFixed(1) + " 分）。", "ok");
          }
        }
        state.rounds = rounds;
        state.stopReason = stopReason;
        renderScoreChip();
        log("已完成 " + rounds.length + " 轮。" + (stopReason ? "停止原因：" + stopReason : ""), "ok");
      } else {
        log("已生成。打开深度模式可以让它自己评审、按停止规则迭代到改不动为止。", "ok");
      }
    }
    setPromptActions(true);
    saveSession();
  } catch (err) {
    markStagesError();
    log((err && err.message) || String(err), "error");
  } finally {
    state.running = false;
    }
}

/* ------------------------------------------------------------------ */
/* markdown preview (minimal + escaped)                                */
/* ------------------------------------------------------------------ */

function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let inCode = false;
  let listType = null;

  const closeList = () => { if (listType) { out.push("</" + listType + ">"); listType = null; } };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out.push("<" + want + ">"); listType = want; }
      out.push("<li>" + inline((ul || ol)[1]) + "</li>");
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\{\{([^}]+)\}\}/g, "<code>{{$1}}</code>");
}
const MAX_ROUNDS = 3;
const SCORE_TARGET = 9;

function scoreOf(critique) {
  if (critique && typeof critique.total === "number") return critique.total;
  const scores = (critique && critique.scores) || {};
  const vals = Object.values(scores).filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** 借鉴 prompt-optimizer 的停止信号：达标停、收益太小停、评委说停就停、轮数用尽停。 */
function decideStop({ round, score, previousScore, critique }) {
  if (score >= SCORE_TARGET) {
    return { stop: true, reason: "第 " + round + " 轮拿到 " + score.toFixed(1) + " 分，已达 " + SCORE_TARGET + " 分门槛" };
  }
  if (previousScore !== null && score - previousScore < 0.3) {
    const delta = score - previousScore;
    return { stop: true, reason: "比上一轮只变化 " + (delta >= 0 ? "+" : "") + delta.toFixed(1) + " 分，继续改写收益太低" };
  }
  if (critique && critique.stopRecommendation === "stop") {
    return { stop: true, reason: "评委判定可以停：" + (critique.stopReason || "再改只是换措辞") };
  }
  if (round >= MAX_ROUNDS) {
    return { stop: true, reason: "已达最大轮数 " + MAX_ROUNDS };
  }
  return { stop: false, reason: "" };
}



/* ------------------------------------------------------------------ */
/* 导出为文档（Markdown）                                              */
/* ------------------------------------------------------------------ */

function activeExportText() {
  if (profileState.mode === "compare" && modelState.cols.length) {
    const c = modelState.cols[modelState.active];
    return c && c.text ? c.text : "";
  }
  return state.prompt || "";
}

function buildExportDoc() {
  const chat = state.activeChat;
  const requirement = $("#raw").value.trim();
  const multi = profileState.mode === "compare" && modelState.cols.length;
  const modelName = multi
    ? modelState.cols.map((c) => c.profile.name).join(" / ")
    : ((selectedProfiles()[0] || {}).name || "规则模式");
  const score = state.critique ? scoreOf(state.critique) : null;

  const out = [];
  out.push("# " + (requirement.slice(0, 40) || "提示词"), "");
  out.push("> 生成模型：" + modelName + " · 导出时间：" + new Date().toLocaleString("zh-CN") +
    (score !== null ? " · 自评 " + score.toFixed(1) + " / 10" + (state.rounds.length > 1 ? "（" + state.rounds.length + " 轮迭代）" : "") : ""));
  out.push("", "## 需求", "", requirement, "");

  if (chat && Object.keys(chat.facts || {}).length) {
    out.push("## 沟通补充得到的信息", "");
    for (const k of Object.keys(chat.facts)) out.push("- **" + k + "**：" + chat.facts[k]);
    out.push("");
  }
  if (chat && chat.messages.some((m) => m.role === "user")) {
    out.push("## 沟通记录", "");
    for (const m of chat.messages) out.push((m.role === "assistant" ? "**AI**：" : "**我**：") + String(m.text).replace(/\n/g, " "));
    out.push("");
  }

  out.push("## 提示词", "", activeExportText().trim(), "");

  const vars = extractVariables(activeExportText());
  if (vars.length) {
    out.push("## 需要替换的变量", "");
    for (const v of vars) out.push("- `{{" + v + "}}`");
    out.push("");
  }
  out.push("---", "", "由 Prompt Studio 导出");
  return out.join("\n");
}

async function exportPrompt() {
  if (!activeExportText().trim()) {
    log("还没有可导出的提示词。", "error");
    return;
  }
  const doc = buildExportDoc();
  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = "prompt-" + stamp + ".md";

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: "Markdown 文档", accept: { "text/markdown": [".md"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(doc);
      await writable.close();
      log("已保存：" + handle.name + "（" + doc.length + " 字）", "ok");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") {
        log("已取消保存。", "");
        return;
      }
      log("「另存为」不可用（" + ((err && err.message) || err) + "），改用下载。", "");
    }
  }

  const blob = new Blob([doc], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggested;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  log("已下载 " + suggested + "（" + doc.length + " 字）。", "ok");
}

/* ------------------------------------------------------------------ */
/* 阶段 0：生成前的多轮沟通补充                                          */
/* ------------------------------------------------------------------ */

const MAX_CHAT_ROUNDS = 4;
const LS_META = "prompt-studio.meta.v1";
const LS_SESSIONS = "prompt-studio.sessions.v1";

function readMeta() {
  const saved = loadJson(LS_META, null) || {};
  return { ask: saved.ask || "", compose: saved.compose || "" };
}

function chatInputSnapshot() {
  return {
    raw: $("#raw").value.trim(),
    target: state.target,
    length: state.length,
    language: state.language,
  };
}

function chatProfile() {
  if (!state.chat) return selectedProfiles()[0] || null;
  return profileState.list.find((p) => p.id === state.chat.modelId) || selectedProfiles()[0] || null;
}

async function startChat() {
  const input = chatInputSnapshot();
  if (!input.raw) {
    log("先在「你的需求」里写一句话。", "error");
    showTab("chat");
    $("#raw").focus();
    return;
  }
  if (!profileState.list.length) {
    log("先在左侧「模型接口」里加一个模型（或点「跳过沟通，直接生成」用内置规则模式）。", "error");
    return;
  }
  const meta = readMeta();
  state.chat = {
    id: "c_" + Date.now().toString(36),
    input,
    modelId: $("#chatModel").value || (selectedProfiles()[0] || {}).id || "",
    messages: [],
    facts: {},
    round: 0,
    maxRounds: MAX_CHAT_ROUNDS,
    status: "asking",
    metaAsk: meta.ask,
    metaCompose: meta.compose,
    createdAt: Date.now(),
  };
  state.prompt = "";
  setPrompt("");
  state.critique = null;
  state.rounds = [];
  state.varValues = {};
  renderAnalysis(null);
  renderScoreChip();
  renderVars();
  showTab("chat");
  renderChat();
  await askTurn();
}

async function askTurn() {
  const chat = state.chat;
  if (!chat) return;
  const profile = chatProfile();
  if (!profile) {
    log("没有可用的模型接口。", "error");
    return;
  }
  setChatBusy(true);
  log("第 " + (chat.round + 1) + " 轮沟通中…（" + profile.name + "）", "");
  try {
    const text = await runCall(buildAskCall(chat.input, chat), null, profile);
    const parsed = parseJsonLoose(text) || {};
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [];
    if (parsed.facts && typeof parsed.facts === "object" && !Array.isArray(parsed.facts)) chat.facts = parsed.facts;
    chat.round += 1;
    const bubbleText = questions.length
      ? questions.map((q, i) => (i + 1) + ". " + (q.question || "") + (q.why ? "（" + q.why + "）" : "")).join("\n")
      : (parsed.ready || "信息已收集完毕，可以点击生成。");
    chat.messages.push({
      role: "assistant",
      at: Date.now(),
      text: bubbleText,
      questions,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      ready: parsed.ready || "",
    });
    chat.status = (parsed.status === "enough" || !questions.length) ? "enough" : "asking";
    renderChat();
    if (chat.status === "enough") {
      log("信息已收集完毕，可以点「生成提示词」了（这一步不会自动触发）。", "ok");
    } else {
      log("第 " + chat.round + " 轮提问完成，回答后我接着问。", "");
    }
  } catch (err) {
    log("沟通失败：" + ((err && err.message) || err), "error");
  } finally {
    setChatBusy(false);
  }
}

async function sendAnswer(skip) {
  const chat = state.chat;
  if (!chat || chat.status === "generating") return;
  const box = $("#chatAnswer");
  const answer = skip ? "（这轮跳过，你按默认决定）" : box.value.trim();
  if (!answer) {
    log("先写一句回答，或者点「这轮跳过」。", "error");
    return;
  }
  chat.messages.push({ role: "user", at: Date.now(), text: answer });
  box.value = "";
  renderChat();
  await askTurn();
}

function setChatBusy(busy) {
  for (const id of ["#chatSend", "#chatSkipRound", "#chatGenerate", "#chatMore", "#startChat"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  const wrap = $("#chatInputWrap");
  if (wrap && !wrap.hidden) wrap.dataset.busy = busy ? "1" : "";
}

function bubbleHtml(m, index, total) {
  const mine = m.role === "user";
  const isLastAssistant = !mine && index === total - 1;
  let inner = escapeHtml(m.text).replace(/\n/g, "<br>");
  if (!mine && isLastAssistant && m.questions && m.questions.length) {
    const chips = m.questions.flatMap((q) => (q.options || []).slice(0, 4));
    if (chips.length) {
      inner += '<div class="chat-chips">' + chips.map((o) =>
        '<button type="button" class="chip chip-btn" data-answer="' + escapeHtml(o) + '">' + escapeHtml(o) + "</button>").join("") + "</div>";
    }
  }
  if (!mine && isLastAssistant && m.missing && m.missing.length) {
    inner += '<div class="chat-missing">' + m.missing.map((x) => escapeHtml(x)).join(" · ") + "</div>";
  }
  return '<div class="bubble ' + (mine ? "bubble-me" : "bubble-ai") + '">' +
    '<span class="bubble-role">' + (mine ? "你" : "AI") + "</span>" + inner + "</div>";
}

function renderChat() {
  const chat = state.chat;
  const logEl = $("#chatLog");
  const factsEl = $("#chatFacts");
  const inputWrap = $("#chatInputWrap");
  const actions = $("#chatActions");

  $("#chatRound").textContent = chat ? ("第 " + chat.round + " 轮 · 最多 " + chat.maxRounds + " 轮") : "还没开始";
  $("#chatRestart").hidden = !chat;

  if (!chat) {
    logEl.innerHTML = '<div class="chat-empty">点左边「开始沟通」，我会先问清几个最关键的问题；' +
      "信息够了再点「生成提示词」，那时候才会真正调用模型写作。沟通阶段不消耗生成动作。</div>";
    factsEl.hidden = true;
    inputWrap.hidden = true;
    actions.hidden = true;
    return;
  }

  logEl.innerHTML = chat.messages.map((m, i) => bubbleHtml(m, i, chat.messages.length)).join("") ||
    '<div class="chat-empty">AI 正在准备第一个问题…</div>';
  for (const btn of logEl.querySelectorAll("button[data-answer]")) {
    btn.addEventListener("click", () => {
      $("#chatAnswer").value = btn.dataset.answer;
      $("#chatAnswer").focus();
    });
  }
  logEl.scrollTop = logEl.scrollHeight;

  const keys = Object.keys(chat.facts || {});
  factsEl.hidden = !keys.length;
  if (keys.length) {
    factsEl.innerHTML = '<h4>已收集到的信息（会一并打包进提示词）</h4>' + keys.map((k) =>
      '<div class="fact-row"><span>' + escapeHtml(k) + '</span><em>' + escapeHtml(String(chat.facts[k])) + "</em></div>").join("");
  }

  inputWrap.hidden = chat.status === "generating";
  actions.hidden = chat.round === 0;
  $("#chatReady").textContent = chat.status === "enough"
    ? "信息已收集完毕，可以点击生成"
    : (chat.status === "generating" ? "正在生成提示词…" : "还差一点也没关系，可以直接生成");
  $("#chatGenerate").textContent = chat.status === "generating" ? "生成中…" : "生成提示词";
}

/* ------------------------------------------------------------------ */
/* 多模型对比                                                          */
/* ------------------------------------------------------------------ */

let modelState = { cols: [], active: 0 };

function setCompareVisible(on) {
  if (!on) modelState = { cols: [], active: 0 };
  applyView({ immediate: true });
}

async function generateCompare(input, picked) {
  modelState = {
    cols: picked.map((p) => ({ profile: p, status: "pending", text: "", ms: null, usage: null, error: "" })),
    active: 0,
  };
  renderModelTabs();
  setCompareVisible(true);
  log("多模型模式：先用「" + picked[0].name + "」解析需求，再让 " + picked.length + " 个模型各自撰写（同一份解析，公平比较）。");

  setStage("analyze", "active");
  let analysis;
  try {
    const analysisText = await runCall(buildAnalyzeCall(input), null, picked[0]);
    analysis = parseJsonLoose(analysisText) || { goal: analysisText.slice(0, 400) };
    state.analysis = analysis;
    renderAnalysis(analysis);
    setStage("analyze", "done");
  } catch (err) {
    markStagesError();
    log("需求解析失败：" + (err && err.message), "error");
    return;
  }

  setStage("compose", "active");
  const call = buildComposeCall(input, analysis, state.activeChat);
  await Promise.all(picked.map((profile, index) => runModelColumn(profile, index, call)));
  setStage("compose", "done");
  state.critique = null;
  state.rounds = [];
  renderScoreChip();
  const done = modelState.cols.filter((c) => c.status === "done").length;
  log("完成：" + done + "/" + picked.length + " 个模型成功。点上面的模型名切换查看，或点「用这版」把它设为主版本。", done === picked.length ? "ok" : "error");
}

async function runModelColumn(profile, index, call) {
  const col = modelState.cols[index];
  col.status = "running";
  col.startedAt = Date.now();
  renderModelTabs();
  try {
    col.text = await runCall(call, (full) => {
      modelState.cols[index].text = full;
      if (index === modelState.active) {
        const body = $("#modelBody");
        if (body) body.textContent = full;
      }
    }, profile, col);
    col.status = "done";
  } catch (err) {
    col.status = "error";
    col.error = (err && err.message) || String(err);
  } finally {
    col.ms = Date.now() - col.startedAt;
    updateModelTab(index);
  }
}

function metaText(c) {
  if (c.status === "running") return "生成中…";
  if (c.status === "error") return "失败";
  if (c.status !== "done") return "排队中";
  const parts = [];
  if (c.ms) parts.push(c.ms + "ms");
  const u = c.usage;
  if (u && u.totalTokens) parts.push(u.totalTokens + "t");
  else if (u && u.outputTokens) parts.push(u.outputTokens + "t");
  return parts.join(" · ");
}

/** 多模型：选项卡切换查看，不并排 */
function renderModelTabs() {
  const tabs = $("#modelTabs");
  const body = $("#modelBody");
  if (!modelState.cols.length) {
    tabs.innerHTML = "";
    body.textContent = "";
    return;
  }
  tabs.innerHTML = modelState.cols.map((c, i) =>
    '<button type="button" class="model-tab" data-index="' + i + '" data-state="' + c.status + '" aria-pressed="' + (i === modelState.active) + '">' +
      '<span class="model-tab-name">' + escapeHtml(c.profile.name) + "</span>" +
      '<span class="model-tab-meta">' + escapeHtml(metaText(c)) + "</span>" +
    "</button>").join("");
  for (const btn of tabs.querySelectorAll(".model-tab")) {
    btn.addEventListener("click", () => {
      modelState.active = Number(btn.dataset.index);
      renderModelTabs();
    });
  }
  const c = modelState.cols[modelState.active];
  body.dataset.state = c.status;
  body.textContent = c.status === "error"
    ? (c.error || "调用失败")
    : (c.text || (c.status === "pending" ? "排队中…" : ""));
  $("#modelUse").disabled = !c.text;
  $("#modelCopy").disabled = !c.text;
}

function updateModelTab(index) {
  const c = modelState.cols[index];
  const btn = document.querySelector('#modelTabs .model-tab[data-index="' + index + '"]');
  if (btn) {
    btn.dataset.state = c.status;
    const meta = btn.querySelector(".model-tab-meta");
    if (meta) meta.textContent = metaText(c);
  }
  if (index === modelState.active) renderModelTabs();
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function section(title, inner) {
  return '<div class="an-section"><h3>' + title + "</h3>" + inner + "</div>";
}

function list(items) {
  if (!items || !items.length) return '<p class="placeholder">—</p>';
  return '<ul class="an-list">' + items.map((x) => "<li>" + escapeHtml(typeof x === "string" ? x : JSON.stringify(x)) + "</li>").join("") + "</ul>";
}

function renderAnalysis(analysis) {
  const host = $("#analysisOut");
  if (!analysis) {
    host.innerHTML = '<p class="placeholder">还没有解析结果。</p>';
    return;
  }
  const a = analysis;
  const rt = a.runtime || {};
  let html = "";
  html += section("目标", '<p>' + escapeHtml(a.goal || "—") + "</p>");
  html += section("定位", '<dl class="kv">' +
    "<dt>任务类型</dt><dd>" + escapeHtml(a.taskType || "—") + "</dd>" +
    "<dt>领域</dt><dd>" + escapeHtml(a.domain || "—") + "</dd>" +
    "<dt>运行时</dt><dd>" + escapeHtml(rt.kind || "—") + " · " + escapeHtml(rt.notes || "") + "</dd>" +
    "<dt>读者</dt><dd>" + escapeHtml(a.audience || "—") + "</dd>" +
    "</dl>");
  const d = a.deliverable || {};
  if (d.format || d.length || d.language) {
    html += section("交付物", '<dl class="kv">' +
      "<dt>格式</dt><dd>" + escapeHtml(d.format || "—") + "</dd>" +
      "<dt>篇幅</dt><dd>" + escapeHtml(d.length || "—") + "</dd>" +
      "<dt>语言</dt><dd>" + escapeHtml(d.language || "—") + "</dd></dl>");
  }
  if (a.inputMaterials) html += section("运行时会拿到的输入", list(a.inputMaterials));
  html += section("硬性约束", list(a.constraints));
  html += section("替你补齐的假设", list(a.assumptions));
  html += section("原始请求的缺口", list(a.gaps));
  if (a.techniques && a.techniques.length) {
    html += section("选用的提示词技术", a.techniques.map((t, i) =>
      '<div class="tech-row"><span class="tech-num">' + (i + 1) + "</span><span><strong>" +
      escapeHtml(t.name || "") + "</strong> — " + escapeHtml(t.why || "") + "</span></div>").join(""));
  }
  if (a.outline && a.outline.length) {
    html += section("结构大纲", '<dl class="kv">' + a.outline.map((o) =>
      "<dt>" + escapeHtml(o.section || "") + "</dt><dd>" + escapeHtml(o.purpose || "") + "</dd>").join("") + "</dl>");
  }
  html += section("质量标准", list(a.qualityBar));
  if (a.risks && a.risks.length) {
    html += section("风险与对策", '<dl class="kv">' + a.risks.map((r) =>
      "<dt>" + escapeHtml(r.risk || "") + "</dt><dd>" + escapeHtml(r.mitigation || "") + "</dd>").join("") + "</dl>");
  }
  if (a.offline) html += '<p class="placeholder">规则模式结果，未调用模型。</p>';
  host.innerHTML = html;
}

/** 自评结果压缩成一个徽标（原来的「自评」标签页已移除，悬停看详情） */
function renderScoreChip() {
  const chip = $("#scoreChip");
  if (!chip) return;
  const c = state.critique;
  if (!c) {
    chip.hidden = true;
    chip.textContent = "";
    chip.title = "";
    return;
  }
  const score = scoreOf(c);
  chip.hidden = false;
  chip.dataset.band = band(score);
  chip.textContent = "自评 " + score.toFixed(1) + (state.rounds.length ? " · " + state.rounds.length + " 轮" : "");
  const perRound = (state.rounds || []).length
    ? "逐轮得分：\n" + state.rounds.map((r) => "  第 " + r.round + " 轮  " + r.score.toFixed(1)).join("\n")
    : "";
  chip.title = [
    c.verdict || "",
    perRound,
    state.stopReason ? "停止原因：" + state.stopReason : "",
    (c.issues || []).length
      ? c.issues.length + " 条待改：\n- " + c.issues.map((i) => (i.problem || "")).join("\n- ")
      : "没有发现需要修的问题",
    c.topFix ? "最高收益改动：" + c.topFix : "",
  ].filter(Boolean).join("\n");
}

function renderVars() {
  const host = $("#varsOut");
  const prompt = state.prompt || "";
  const vars = extractVariables(prompt);
  if (!vars.length) {
    host.innerHTML = '<p class="placeholder">提示词里还没有 {{变量}}。让模型把可变的输入参数化，这里就会列出，并可以直接填写生成最终版。</p>';
    return;
  }
  const values = state.varValues || (state.varValues = {});
  host.innerHTML =
    '<div class="an-section"><h3>填写变量</h3>' + vars.map((v) =>
      '<div class="var-row"><code>{{' + escapeHtml(v) + "}}</code>" +
      '<input type="text" class="var-input" data-var-input="' + escapeHtml(v) + '" spellcheck="false" placeholder="填入值" value="' +
      escapeHtml(values[v] || "") + '"></div>').join("") + "</div>" +
    '<div class="an-section"><div class="var-final-head"><h3>最终提示词</h3>' +
      '<button type="button" class="ghost" id="copyFilled">复制最终版</button>' +
      '<button type="button" class="ghost" id="clearVars">清空</button></div>' +
      '<pre class="var-final" id="varFinal"></pre></div>';

  const renderFinal = () => {
    let text = prompt;
    for (const v of vars) {
      const val = (values[v] || "").trim();
      text = text.split("{{" + v + "}}").join(val ? val : "{{" + v + "}}");
    }
    const node = $("#varFinal");
    if (node) node.textContent = text;
  };

  for (const input of host.querySelectorAll("input[data-var-input]")) {
    input.addEventListener("input", () => {
      values[input.dataset.varInput] = input.value;
      renderFinal();
    });
  }
  $("#copyFilled").addEventListener("click", async () => {
    const ok = await copyText($("#varFinal").textContent);
    log(ok ? "最终提示词已复制到剪贴板。" : "浏览器拒绝了自动复制，请手动选中复制。", ok ? "ok" : "error");
  });
  $("#clearVars").addEventListener("click", () => {
    state.varValues = {};
    renderVars();
  });
  renderFinal();
}

function setPromptActions(enabled) {
  $("#copyPrompt").disabled = !enabled;
  $("#exportPrompt").disabled = !enabled;
}

function renderPreview() {
  const host = $("#promptPreview");
  if (host) host.innerHTML = renderMarkdown(state.prompt || "");
}

let previewTimer = 0;
function schedulePreviewRender() {
  if (previewTimer) return;
  previewTimer = setTimeout(() => { previewTimer = 0; renderPreview(); }, 160);
}

function applyView(options) {
  // 多模型模式：显示「模型选项卡 + 当前模型正文」，不再并排
  const multi = profileState.mode === "compare" && modelState.cols.length > 0;
  const switchEl = $("#modelSwitch");
  const bodyEl = $("#modelBody");
  if (switchEl) switchEl.hidden = !multi;
  if (bodyEl) bodyEl.hidden = !multi;
  if (multi) {
    $("#editorShell").hidden = true;
    $("#emptyState").hidden = true;
    return;
  }
  const hasText = Boolean((state.prompt || "").trim());
  const shell = $("#editorShell");
  $("#emptyState").hidden = hasText;
  if (shell) shell.hidden = !hasText;
  if (!hasText) return;
  if (options && options.immediate) {
    clearTimeout(previewTimer);
    previewTimer = 0;
    renderPreview();
  } else {
    schedulePreviewRender();
  }
}

function toggleFullscreen(force) {
  const shell = $("#editorShell");
  if (!shell) return;
  const on = typeof force === "boolean" ? force : !shell.classList.contains("is-fullscreen");
  shell.classList.toggle("is-fullscreen", on);
  document.body.classList.toggle("has-fullscreen", on);
  $("#expandEditor").textContent = on ? "退出全屏" : "全屏";
}

async function copyText(text) {
  const value = String(text == null ? "" : text);
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
/* ------------------------------------------------------------------ */
/* model interface panel                                               */
/* ------------------------------------------------------------------ */

/** 顶栏状态：本地服务 + 选中的接口数 */
function updateModeChip() {
  const chip = $("#modeChip");
  const retry = $("#retryServer");
  const picked = selectedProfiles();
  const enabled = profileState.list.filter((p) => p.enabled).length;

  if (!DIRECT && !state.serverAlive) {
    chip.textContent = "本地服务已断开";
    chip.dataset.state = "down";
    retry.hidden = false;
  } else {
    retry.hidden = true;
    if (DIRECT || !profileState.available) {
      chip.textContent = "需要本地服务";
      chip.dataset.state = "offline";
    } else if (profileState.mode === "compare") {
      chip.textContent = "对比 " + picked.length + " 个模型";
      chip.dataset.state = picked.length >= 2 ? "online" : "offline";
    } else if (picked.length) {
      chip.textContent = picked[0].name;
      chip.dataset.state = "online";
    } else {
      chip.textContent = "未选择模型";
      chip.dataset.state = enabled ? "offline" : "offline";
    }
  }
  const note = $("#apiNote");
  if (!profileState.available) {
    note.textContent = "多接口管理需要本地服务：请用 node server.mjs 启动后访问 http://127.0.0.1:5178。";
  } else {
    note.textContent = (profileState.encryption === "dpapi"
      ? "接口配置存在本机 data/profiles.json，API Key 用 Windows DPAPI 加密（绑定当前用户）。"
      : "接口配置存在本机 data/profiles.json，API Key 未加密（当前系统不支持 DPAPI）。")
      + " 页面里只显示掩码，密钥永远不会回传给浏览器。";
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); startChat(); });

  $("#raw").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); startChat(); }
  });
  $("#lengthSel").addEventListener("change", (e) => {
    state.length = e.target.value;
    syncLengthSelect();
  });

  $("#deep").addEventListener("change", (e) => { state.deep = e.target.checked; });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }

  $("#expandEditor").addEventListener("click", () => toggleFullscreen());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#editorShell").classList.contains("is-fullscreen")) toggleFullscreen(false);
  });

  $("#copyPrompt").addEventListener("click", async () => {
    if (!state.prompt) return;
    const btn = $("#copyPrompt");
    const ok = await copyText(state.prompt);
    if (ok) {
      btn.textContent = "已复制";
      btn.disabled = true;
      log("提示词已复制到剪贴板。", "ok");
      setTimeout(() => { btn.textContent = "复制"; btn.disabled = false; }, 1600);
    } else {
      const editor = $("#promptOut");
      editor.focus();
      editor.select();
      log("浏览器拒绝了自动复制，已帮你全选内容，按 Ctrl / ⌘ + C 复制。", "error");
    }
  });

  const editor = $("#promptOut");
  editor.addEventListener("input", (e) => {
    state.prompt = e.target.value;
    $("#meter").textContent = state.prompt.length + " 字 · ~" + estimateTokens(state.prompt) + " tokens";
    renderVars();
    applyView();
  });

  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); generate(); return; }
    const tab = "  ";
    if (e.key === "Tab") {
      e.preventDefault();
      const value = editor.value;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (start !== end) {
        const from = value.lastIndexOf("\n", start - 1) + 1;
        const block = value.slice(from, end);
        const shifted = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, tab);
        editor.setRangeText(shifted, from, end, "select");
      } else if (e.shiftKey) {
        const from = value.lastIndexOf("\n", start - 1) + 1;
        const line = value.slice(from).split("\n")[0];
        if (line.startsWith(tab)) editor.setRangeText(line.slice(tab.length), from, from + line.length, "end");
        else if (line.startsWith(" ")) editor.setRangeText(line.slice(1), from, from + line.length, "end");
      } else {
        editor.setRangeText(tab, start, end, "end");
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && editor.selectionStart === editor.selectionEnd) {
      const start = editor.selectionStart;
      const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
      const line = editor.value.slice(lineStart, start);
      const m = line.match(/^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/);
      if (!m || !m[3].trim()) return;
      e.preventDefault();
      const marker = /^\d/.test(m[2]) ? (Number.parseInt(m[2], 10) + 1) + m[2].replace(/^\d+/, "") : m[2];
      editor.setRangeText("\n" + m[1] + marker + " ", start, editor.selectionEnd, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // 清空需求时，同步清掉这次沟通
  const raw = $("#raw");
  let rawHadText = raw.value.trim().length > 0;
  raw.addEventListener("input", () => {
    const hasText = raw.value.trim().length > 0;
    if (hasText) { rawHadText = true; return; }
    if (rawHadText) {
      state.chat = null;
      state.activeChat = null;
      renderChat();
    }
    rawHadText = false;
  });

  $("#retryServer").addEventListener("click", () => pingServer(true));
  $("#exportPrompt").addEventListener("click", () => exportPrompt());
  $("#modelUse").addEventListener("click", () => {
    const c = modelState.cols[modelState.active];
    if (!c || !c.text) return;
    state.prompt = c.text;
    setPrompt(c.text);
    log("已把「" + c.profile.name + "」设为主版本，切到「单模型」或直接用「变量」继续处理。", "ok");
  });
  $("#modelCopy").addEventListener("click", async () => {
    const c = modelState.cols[modelState.active];
    const ok = await copyText(c ? c.text : "");
    log(ok ? "已复制「" + (c ? c.profile.name : "") + "」的版本。" : "浏览器拒绝了自动复制。", ok ? "ok" : "error");
  });

  // ---- 沟通 ----
  $("#startChat").addEventListener("click", () => startChat());
  $("#skipChat").addEventListener("click", () => {
    state.activeChat = null;
    showTab("prompt");
    generate();
  });
  $("#chatSend").addEventListener("click", () => sendAnswer(false));
  $("#chatSkipRound").addEventListener("click", () => sendAnswer(true));
  $("#chatMore").addEventListener("click", () => {
    const box = $("#chatAnswer");
    if (box) { box.focus(); box.placeholder = "还想补充什么？直接说，我会接着问。"; }
  });
  $("#chatGenerate").addEventListener("click", () => {
    if (!state.chat) return;
    state.chat.status = "generating";
    state.activeChat = state.chat;
    renderChat();
    showTab("prompt");
    generate();
  });
  $("#chatRestart").addEventListener("click", () => {
    state.chat = null;
    state.activeChat = null;
    renderChat();
    log("已清空这次沟通，可以重新开始。", "");
  });
  $("#chatAnswer").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendAnswer(false); }
  });
  $("#chatModel").addEventListener("change", () => {
    if (state.chat) state.chat.modelId = $("#chatModel").value;
  });

  // ---- 元提示词模板 ----
  $("#metaSave").addEventListener("click", () => {
    const ask = $("#metaAsk").value.trim();
    const compose = $("#metaCompose").value.trim();
    saveJson(LS_META, {
      ask: ask && ask !== ASK_SYSTEM.trim() ? ask : "",
      compose: compose && compose !== COMPOSE_SYSTEM.trim() ? compose : "",
    });
    fillMeta();
    log("元提示词模板已保存。下一轮沟通 / 下一次生成生效。", "ok");
  });
  $("#metaReset").addEventListener("click", () => {
    saveJson(LS_META, {});
    fillMeta();
    log("已恢复默认元提示词。", "ok");
  });

  // ---- 历史会话 ----
  $("#sessionList").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.closest(".session-row").dataset.id;
    if (btn.dataset.act === "del") {
      state.sessions = state.sessions.filter((x) => x.id !== id);
      saveJson(LS_SESSIONS, state.sessions);
      renderSessions();
      return;
    }
    loadSession(id);
  });
}

/* ------------------------------------------------------------------ */
/* 元提示词模板 + 历史会话                                              */
/* ------------------------------------------------------------------ */

function fillMeta() {
  const m = readMeta();
  $("#metaAsk").value = m.ask || ASK_SYSTEM;
  $("#metaCompose").value = m.compose || COMPOSE_SYSTEM;
  $("#metaState").textContent = (m.ask || m.compose) ? "已自定义" : "默认";
  const chat = state.chat;
  if (chat) { chat.metaAsk = m.ask; chat.metaCompose = m.compose; }
}

function renderChatModelOptions() {
  const sel = $("#chatModel");
  const usable = profileState.list.filter((p) => p.enabled);
  const current = sel.value || (state.chat && state.chat.modelId) || "";
  sel.innerHTML = usable.length
    ? usable.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + "</option>").join("")
    : '<option value="">（没有可用接口）</option>';
  if (current && usable.some((p) => p.id === current)) sel.value = current;
  else if (usable.length) sel.value = usable[0].id;
}

function saveSession() {
  if (!state.prompt) return;
  const chat = state.chat;
  const session = {
    id: (chat && chat.id) || ("s_" + Date.now().toString(36)),
    at: Date.now(),
    requirement: chat ? chat.input.raw : $("#raw").value.trim(),
    target: state.target,
    length: state.length,
    language: state.language,
    messages: chat ? chat.messages : [],
    facts: chat ? chat.facts : {},
    prompt: state.prompt,
    model: selectedProfiles().map((p) => p.name).join(" + ") || "规则模式",
  };
  state.sessions = [session, ...state.sessions.filter((x) => x.id !== session.id)].slice(0, 30);
  saveJson(LS_SESSIONS, state.sessions);
  renderSessions();
}

function renderSessions() {
  const host = $("#sessionList");
  $("#historyCount").textContent = state.sessions.length + " 条";
  if (!state.sessions.length) {
    host.innerHTML = '<p class="placeholder">还没有会话。沟通 + 生成之后会自动存一条，这里可以回看。</p>';
    return;
  }
  host.innerHTML = state.sessions.map((x) => {
    const d = new Date(x.at);
    const stamp = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    return '<div class="session-row" data-id="' + x.id + '">' +
      '<button type="button" class="session-main" data-act="open">' +
        '<span class="session-title">' + escapeHtml(x.requirement.slice(0, 24) || "（未命名）") + "</span>" +
        '<span class="session-meta">' + stamp + " · " + escapeHtml(x.model) + " · " + (x.messages ? x.messages.length : 0) + " 轮 · " + (x.prompt || "").length + " 字</span>" +
      "</button>" +
      '<button type="button" class="ghost tiny" data-act="del">删除</button>' +
    "</div>";
  }).join("");
}

function loadSession(id) {
  const x = state.sessions.find((v) => v.id === id);
  if (!x) return;
  $("#raw").value = x.requirement || "";
  state.target = x.target || state.target;
  state.length = x.length || state.length;
  state.language = x.language || state.language;
  syncLengthSelect();
  if (x.messages && x.messages.length) {
    state.chat = {
      id: x.id, input: { raw: x.requirement, target: x.target, length: x.length, language: x.language, extra: x.extra },
      modelId: "", messages: x.messages, facts: x.facts || {}, round: x.messages.filter((m) => m.role === "assistant").length,
      maxRounds: MAX_CHAT_ROUNDS, status: "enough", createdAt: x.at,
    };
    state.activeChat = state.chat;
  } else {
    state.chat = null;
    state.activeChat = null;
  }
  renderChat();
  setPrompt(x.prompt || "");
  setPromptActions(Boolean(x.prompt));
  showTab(x.prompt ? "prompt" : "chat");
  log("已载入会话：" + (x.requirement || "").slice(0, 24), "ok");
}

async function pingServer(manual) {
  if (DIRECT) { state.serverAlive = false; updateModeChip(); return false; }
  const wasAlive = state.serverAlive;
  try {
    const resp = await fetch("/api/health", { cache: "no-store" });
    if (!resp.ok) throw new Error("status " + resp.status);
    const data = await resp.json();
    state.serverAlive = true;
    // B3：加密方案随接口返回，不是 dpapi 就在页面顶部给一条看得见的告警，不能只藏在小字里
    const enc = data.defaults && data.defaults.encryption;
    const warn = $("#cryptoWarn");
    if (warn) {
      if (enc && enc !== "dpapi") {
        warn.hidden = false;
        warn.textContent = "⚠ 你的 API Key 当前以「" + enc + "」方式保存（本机 DPAPI 不可用），这层保护形同虚设。" +
          "建议：把接口配置放在受控机器上，或改用环境变量注入 Key。";
      } else {
        warn.hidden = true;
        warn.textContent = "";
      }
    }
  } catch {
    state.serverAlive = false;
  }
  updateModeChip();
  if (manual) {
    log(state.serverAlive ? "本地服务正常，可以开始生成。" : "还是连不上本地服务 " + location.origin + "。请在 prompt-studio 目录执行 node server.mjs，再点一次「重新连接」。",
      state.serverAlive ? "ok" : "error");
  } else if (!wasAlive && state.serverAlive) {
    log("本地服务已恢复。", "ok");
  }
  return state.serverAlive;
}

async function boot() {
  initProfiles({
    log,
    onChange: () => { updateModeChip(); renderChatModelOptions(); applyView(); },
  });

  const draft = loadJson("prompt-studio.draft.v1", null);
  if (draft) {
    $("#raw").value = draft.raw || "";
    state.length = draft.length || state.length;
  }

  syncLengthSelect();

  bindEvents();
  renderVars();
  resetStages(false);
  applyView();

  await pingServer(false);
  if (!DIRECT && state.serverAlive) await loadProfiles();
  renderProfiles();
  updateModeChip();
  setInterval(() => { if (!state.serverAlive) pingServer(false); }, 8000);

  state.sessions = loadJson(LS_SESSIONS, []) || [];
  fillMeta();
  renderChatModelOptions();
  renderChat();
  renderSessions();


  if (DIRECT) log("当前以 file:// 直接打开：多接口模式需要本地服务，请在项目目录执行 node server.mjs 后访问 http://127.0.0.1:5178。", "");

  document.documentElement.dataset.appReady = "1";
}

boot();