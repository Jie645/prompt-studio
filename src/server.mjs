#!/usr/bin/env node
/**
 * Prompt Studio - local server
 * Zero dependencies. Serves ../public and relays model API calls.
 *
 *   node server.mjs            (http://127.0.0.1:5178)
 *   PORT=6000 node server.mjs
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor } from "./public/js/adapters.mjs";

const ROOT = resolve(fileURLToPath(new URL("./public", import.meta.url)));
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const KEY_SOURCES = ["PROMPT_STUDIO_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"];

const envDefaults = {
  baseUrl: process.env.PROMPT_STUDIO_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  model: process.env.PROMPT_STUDIO_MODEL || process.env.OPENAI_MODEL || "gpt-5",
  apiStyle: process.env.PROMPT_STUDIO_API_STYLE || "chat",
  // B3：把当前真实的加密方案报出去，前端据此给可见告警（不能只藏在小字里）
  get encryption() { return dpapiAvailable() ? "dpapi" : "base64"; },
  keySources: Object.fromEntries(KEY_SOURCES.map((name) => [name, Boolean(process.env[name])])),
  get hasKey() { return Object.values(this.keySources).some(Boolean); },
};

function isLocalHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch { return false; }
}

/**
 * Pick an environment key that actually matches the provider being called.
 * Sending an OpenAI key to DeepSeek (or the reverse) fails with a confusing 401,
 * so the provider name in the base URL decides which variable wins.
 */
function pickEnvKey(baseUrl) {
  if (process.env.PROMPT_STUDIO_API_KEY) return { key: process.env.PROMPT_STUDIO_API_KEY, source: "PROMPT_STUDIO_API_KEY" };
  const host = String(baseUrl || "").toLowerCase();
  for (const name of KEY_SOURCES) {
    const provider = name === "DEEPSEEK_API_KEY" ? "deepseek" : name === "OPENAI_API_KEY" ? "openai" : "";
    if (!provider || !host.includes(provider)) continue;
    if (process.env[name]) return { key: process.env[name], source: name };
  }
  return { key: "", source: "" };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function upstreamUrl(baseUrl, apiStyle) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("缺少 API Base URL");
  if (/\/(chat\/completions|responses)$/.test(base)) return base;
  return base + (apiStyle === "responses" ? "/responses" : "/chat/completions");
}


/* ------------------------------------------------------------------ */
/* 模型接口配置：存储 + 密钥加密（Windows DPAPI，绑定当前用户）          */
/* ------------------------------------------------------------------ */

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE_DIR, "data");
const PROFILES_FILE = join(DATA_DIR, "profiles.json");
const keyCache = new Map();
let dpapiState = null;

/**
 * B3：脚本内容走 stdin 传（`-Command -`），命令行上只剩 `-Command -`。
 * 以前是把密钥的 base64 拼进命令行，同一账户下的任何进程都能从 Win32_Process.CommandLine
 * 读到（本项目的卸载脚本自己就这么找进程），还会进 ETW / 审计日志。
 */
function runPowerShell(script) {
  const prelude = "Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;\n";
  const res = spawnSync("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-",
  ], {
    input: prelude + script,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(String(res.stderr || ("powershell 退出码 " + res.status)).trim());
  return String(res.stdout || "").trim();
}

let dpapiReason = "";
function dpapiAvailable() {
  if (dpapiState !== null) return dpapiState;
  if (process.platform !== "win32") { dpapiState = false; dpapiReason = "非 Windows 平台"; return false; }
  try {
    const probe = runPowerShell("$b=[Text.Encoding]::UTF8.GetBytes('probe');$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)");
    dpapiState = Boolean(probe && probe.length > 16);
    if (!dpapiState) dpapiReason = "DPAPI 探测返回了空结果";
  } catch (err) {
    dpapiState = false;
    dpapiReason = String((err && err.message) || err);
  }
  if (!dpapiState) {
    console.warn("[prompt-studio] 警告：本机 DPAPI 不可用（" + dpapiReason + "），密钥将退化为 base64 伪加密存储。");
  }
  return dpapiState;
}

function protectKey(plain) {
  if (!plain) return null;
  if (dpapiAvailable()) {
    const b64 = Buffer.from(plain, "utf8").toString("base64");
    const enc = runPowerShell("$b=[Convert]::FromBase64String('" + b64 + "');$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)");
    return { scheme: "dpapi", data: enc };
  }
  return { scheme: "base64", data: Buffer.from(plain, "utf8").toString("base64") };
}

function revealKey(profile) {
  if (!profile || !profile.keyCipher) return "";
  if (keyCache.has(profile.id)) return keyCache.get(profile.id);
  let plain = "";
  try {
    if (profile.keyCipher.scheme === "dpapi") {
      plain = runPowerShell("$b=[Convert]::FromBase64String('" + profile.keyCipher.data + "');$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Text.Encoding]::UTF8.GetString($p)");
    } else {
      plain = Buffer.from(profile.keyCipher.data, "base64").toString("utf8");
    }
  } catch { plain = ""; }
  keyCache.set(profile.id, plain);
  return plain;
}

function keyHint(plain) {
  const v = String(plain || "");
  if (!v) return "";
  return v.length <= 6 ? v.slice(0, 2) + "…" : v.slice(0, 3) + "…" + v.slice(-4);
}

/** 最近一次读取出的问题（B2）。一旦命中就保持到进程结束，接口会据此报错而不是假装"没有配置"。 */
let storeProblem = "";

function loadStore() {
  let raw = null;
  try {
    raw = readFileSync(PROFILES_FILE, "utf8");
  } catch {
    return { version: 1, profiles: [] };     // 文件不存在 = 全新安装，正常
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error("缺少 profiles 数组");
    return parsed;
  } catch (err) {
    // B2：以前这里 catch{} 把「解析失败」当成「没有配置」，紧接着 GET 会把空配置写盘，原数据彻底消失。
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = PROFILES_FILE + ".corrupt-" + stamp;
    let renamed = false;
    try { renameSync(PROFILES_FILE, backup); renamed = true; } catch (e2) {
      console.error("[prompt-studio] 备份损坏文件也失败了：" + ((e2 && e2.message) || e2));
    }
    storeProblem = "接口配置文件解析失败（" + ((err && err.message) || err) + "）" +
      (renamed ? "，原文件已备份为 " + backup + "。请检查该备份后恢复。" : "，且备份失败，请立刻手动备份 data 目录。");
    console.error("[prompt-studio] ⚠ " + storeProblem);
    return { version: 1, profiles: [] };
  }
}

function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  // B2：写新文件前留一份 .bak，写一半损坏时还有得恢复
  try {
    if (existsSync(PROFILES_FILE)) copyFileSync(PROFILES_FILE, PROFILES_FILE + ".bak");
  } catch (err) {
    console.warn("[prompt-studio] 写备份失败（不影响主流程）：" + ((err && err.message) || err));
  }
  const tmp = PROFILES_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, PROFILES_FILE);
}

/** 对外只暴露掩码，绝不回传密钥本体 */
function publicProfile(p) {
  const { keyCipher, ...rest } = p;
  const env = keyCipher ? { source: "" } : pickEnvKey(p.baseUrl);
  return {
    ...rest,
    hasKey: Boolean(keyCipher),
    keyScheme: keyCipher ? keyCipher.scheme : null,
    keyFromEnv: env.source || "",
  };
}

/** 首次启动时，用环境变量里的 Key 自动铺两条接口，省得手动填 */
const SEEDS = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-flash", note: "Key 来自环境变量 DEEPSEEK_API_KEY" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelId: "gpt-5", note: "Key 来自环境变量 OPENAI_API_KEY" },
];

function seedFromEnv(store) {
  if (store.profiles.length) return false;
  let changed = false;
  for (const seed of SEEDS) {
    const picked = pickEnvKey(seed.baseUrl);
    if (!picked.key || picked.source === "PROMPT_STUDIO_API_KEY") continue;
    store.profiles.push(sanitizeProfile({
      name: seed.name, protocol: "openai", baseUrl: seed.baseUrl, modelId: seed.modelId,
      note: seed.note, enabled: true,
    }, null));
    changed = true;
  }
  if (changed) saveStore(store);
  return changed;
}

function newId() {
  return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * B7：params 采用「整体替换」语义 —— 只要这次提交带了 params，就用它整份替换旧值。
 * 为什么不是合并：前端清空输入框时提交的是 `{temperature: undefined}`，
 * 而 JSON.stringify 会把 undefined 的键直接丢掉，服务端只看到 `{}`，
 * 合并语义下永远清不掉旧值（这就是 B7 的根因）。空值（null/undefined/""）视为"不设该参数"。
 */
function sanitizeParams(incoming) {
  const out = {};
  if (!incoming || typeof incoming !== "object") return out;
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

/** L10：数字参数范围校验，非法值直接报错，不静默变成 null */
function validateParams(params) {
  const p = params || {};
  const check = (key, min, max, label) => {
    if (p[key] === undefined || p[key] === null || p[key] === "") return "";
    const n = Number(p[key]);
    if (!Number.isFinite(n)) return label + " 要填数字。";
    if (n < min || n > max) return label + " 要在 " + min + " 到 " + max + " 之间。";
    return "";
  };
  return check("temperature", 0, 2, "temperature") || check("maxTokens", 1, 200000, "maxTokens");
}

function sanitizeProfile(input, base) {
  const p = base || {};
  const params = input.params === undefined ? (p.params || {}) : sanitizeParams(input.params);
  return {
    id: p.id || newId(),
    name: String(input.name ?? p.name ?? "未命名接口").slice(0, 60),
    protocol: ["openai", "anthropic", "custom"].includes(input.protocol) ? input.protocol : (p.protocol || "openai"),
    apiStyle: input.apiStyle === "responses" ? "responses" : (input.apiStyle === "chat" ? "chat" : (p.apiStyle || "chat")),
    baseUrl: String(input.baseUrl ?? p.baseUrl ?? "").trim(),
    modelId: String(input.modelId ?? p.modelId ?? "").trim(),
    enabled: input.enabled === undefined ? (p.enabled !== false) : Boolean(input.enabled),
    note: String(input.note ?? p.note ?? "").slice(0, 200),
    params,
    createdAt: p.createdAt || Date.now(),
    updatedAt: Date.now(),
    lastTest: p.lastTest || null,
  };
}

async function pingProfile(profile, apiKey) {
  const adapter = adapterFor(profile);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(adapter.endpoint(profile), {
      method: "POST",
      headers: adapter.headers(profile, apiKey),
      body: JSON.stringify(adapter.body(profile, { system: "You are a connectivity probe.", user: "Reply with the single word: ok", stream: false, json: false })),
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => "");
    const ms = Date.now() - started;
    if (!resp.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || msg; } catch {}
      return { ok: false, ms, message: "HTTP " + resp.status + " " + (msg || "") };
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { ok: true, ms, message: (adapter.text(parsed) || "ok").trim().slice(0, 60) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: String((err && err.message) || err) };
  } finally { clearTimeout(timer); }
}

async function handleRelay(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: { message: "请求体解析失败: " + err.message } });
  }

  const baseUrl = (payload.baseUrl || "").trim() || envDefaults.baseUrl;
  const apiStyle = payload.apiStyle === "responses" ? "responses" : "chat";
  const upstreamBody = payload.body;

  // L12：不再接受浏览器在 body 里塞明文 Key（历史攻击面），只允许服务端自己的环境变量
  const picked = pickEnvKey(baseUrl);
  const apiKey = picked.key;
  const allowNoKey = isLocalHost(baseUrl);

  if (!apiKey && !allowNoKey) {
    const available = KEY_SOURCES.filter((n) => process.env[n]);
    const detail = available.length
      ? "服务端目前只有 " + available.join(" / ") + "，都与当前 Base URL 不匹配。"
      : "服务端也没有设置任何环境变量 Key。";
    return json(res, 400, { error: { message: "缺少 API Key：请在左侧「模型接口」里填写与 " + baseUrl + " 匹配的 Key。" + detail } });
  }
  if (!upstreamBody || typeof upstreamBody !== "object") return json(res, 400, { error: { message: "缺少请求体 body" } });

  let url;
  try {
    url = upstreamUrl(baseUrl, apiStyle);
  } catch (err) {
    return json(res, 400, { error: { message: err.message } });
  }

  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
  };
  return forwardUpstream(req, res, url, headers, upstreamBody, picked.source || "none");
}

/** 把上游响应原样回灌给浏览器（含流式） —— 所有转发路径共用 */
async function forwardUpstream(req, res, targetUrl, headers, bodyObj, label) {
  const controller = new AbortController();
  // L13：300s 是总上限，另外再加一个"上游一直不出数据"的空闲超时
  const hardTimer = setTimeout(() => controller.abort(), 300000);
  let idleTimer = setTimeout(() => controller.abort(), 60000);
  const bumpIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), 60000); };
  const cleanup = () => { clearTimeout(hardTimer); clearTimeout(idleTimer); };
  req.on("close", cleanup);

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    const hint = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|abort|timeout/i.test(String(err && err.message))
      ? "无法连接到模型服务（网络被拦截、地址错误，或长时间没有响应）。请检查 Base URL 是否可访问。"
      : String(err && err.message);
    return json(res, 502, { error: { message: "上游请求失败: " + hint, url: targetUrl } });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    cleanup();
    let msg = text.slice(0, 900);
    try {
      const parsed = JSON.parse(text);
      msg = parsed?.error?.message || parsed?.message || msg;
    } catch {}
    return json(res, upstream.status, { error: { message: msg || ("上游返回 " + upstream.status), status: upstream.status, url: targetUrl } });
  }

  const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    ...(label && /^[\x20-\x7e]*$/.test(label) ? { "x-prompt-studio-source": label } : {}),
  });
  if (!upstream.body) {
    cleanup();
    return res.end();
  }
  try {
    await upstream.body.pipeTo(new WritableStream({
      write(chunk) {
        bumpIdle();
        // L13：res.write 返回 false 说明内核缓冲已满，等 drain 再继续，避免内存里堆整段响应
        if (!res.write(chunk)) {
          return new Promise((resolve) => res.once("drain", resolve));
        }
      },
      close() { res.end(); },
      abort() { res.end(); },
    }));
  } catch {
    try { res.end(); } catch {}
  } finally {
    cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* 模型接口的增删改查 + 按 id 转发                                       */
/* ------------------------------------------------------------------ */

async function handleProfiles(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";
  const action = parts[3] || "";
  const store = loadStore();

  if (!id) {
    if (req.method === "GET") {
      // B2：配置文件坏掉时不能假装"没有配置"，否则前端一保存就把原数据覆盖了
      if (storeProblem) return json(res, 500, { error: { message: storeProblem } });
      return json(res, 200, {
        profiles: store.profiles.map(publicProfile),
        encryption: dpapiAvailable() ? "dpapi" : "base64",
        store: PROFILES_FILE,
      });
    }
    if (req.method === "POST") {
      let input;
      try { input = await readJsonBody(req); } catch (err) { return json(res, 400, { error: { message: "请求体解析失败: " + err.message } }); }
      const bad = validateParams(input.params);
      if (bad) return json(res, 400, { error: { message: bad } });
      const profile = sanitizeProfile(input, null);
      const plain = String(input.apiKey || "").trim();
      if (plain) { profile.keyCipher = protectKey(plain); profile.keyHint = keyHint(plain); }
      store.profiles.push(profile);
      saveStore(store);
      return json(res, 200, { profile: publicProfile(profile) });
    }
    return json(res, 405, { error: { message: "不支持的方法" } });
  }

  const index = store.profiles.findIndex((p) => p.id === id);
  if (index < 0) return json(res, 404, { error: { message: "找不到该接口配置：" + id } });
  const current = store.profiles[index];

  if (req.method === "PATCH" || req.method === "PUT") {
    let input;
    try { input = await readJsonBody(req); } catch (err) { return json(res, 400, { error: { message: "请求体解析失败: " + err.message } }); }
    const bad = validateParams(input.params === undefined ? current.params : sanitizeParams(input.params));
    if (bad) return json(res, 400, { error: { message: bad } });
    const next = sanitizeProfile(input, current);
    if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
      const plain = String(input.apiKey || "").trim();
      keyCache.delete(id);
      if (plain) { next.keyCipher = protectKey(plain); next.keyHint = keyHint(plain); }
      else { next.keyCipher = null; next.keyHint = ""; }
    } else {
      next.keyCipher = current.keyCipher;
      next.keyHint = current.keyHint;
    }
    store.profiles[index] = next;
    saveStore(store);
    return json(res, 200, { profile: publicProfile(next) });
  }

  if (req.method === "DELETE") {
    store.profiles.splice(index, 1);
    saveStore(store);
    keyCache.delete(id);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "test") {
    const result = await pingProfile(current, revealKey(current) || pickEnvKey(current.baseUrl).key);
    current.lastTest = { at: Date.now(), ok: result.ok, ms: result.ms, message: result.message };
    store.profiles[index] = current;
    saveStore(store);
    return json(res, 200, { ok: result.ok, ms: result.ms, message: result.message, lastTest: current.lastTest });
  }

  return json(res, 405, { error: { message: "不支持的方法" } });
}

async function handleRelayById(req, res, id) {
  const store = loadStore();
  const profile = store.profiles.find((p) => p.id === id);
  if (!profile) return json(res, 404, { error: { message: "找不到该接口配置：" + id } });
  if (profile.enabled === false) return json(res, 400, { error: { message: "该接口已被禁用：" + profile.name } });

  let payload;
  try { payload = await readJsonBody(req); } catch (err) { return json(res, 400, { error: { message: "请求体解析失败: " + err.message } }); }

  // B9：先校验 Base URL，再谈 Key —— 以前空 URL 会报成"缺少 API Key"，把人带偏
  if (!String(profile.baseUrl || "").trim()) {
    return json(res, 400, { error: { message: "接口「" + profile.name + "」还没填 Base URL，先补上再调用（例如 https://api.deepseek.com/v1）。" } });
  }

  const adapter = adapterFor(profile);
  const apiKey = revealKey(profile) || pickEnvKey(profile.baseUrl).key;
  if (!apiKey && !isLocalHost(profile.baseUrl)) {
    return json(res, 400, { error: { message: "接口「" + profile.name + "」没有可用的 API Key（未填写，或密钥解不开 —— 换了 Windows 账户或换了机器会导致 DPAPI 解不开）。请重新填写密钥。" } });
  }

  // B4 / B10：模板渲染或解析失败是"参数问题"，回 400 且只给中文可操作提示；其它异常交给外层 500
  let body;
  try {
    body = adapter.body(profile, {
      system: payload.system || "",
      user: payload.user || "",
      stream: Boolean(payload.stream),
      json: Boolean(payload.json),
    }, payload.vars);
  } catch (err) {
    if (err && err.name === "TemplateError") {
      console.warn("[prompt-studio] 模板渲染失败：" + (err.detail || err.message));
      return json(res, 400, { error: { message: err.message } });
    }
    throw err;
  }
  return forwardUpstream(req, res, adapter.endpoint(profile), adapter.headers(profile, apiKey), body, profile.id);
}

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const target = resolve(join(ROOT, normalize(rel)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 Not Found");
  }
}

/** L12：只接受来自本机页面的 /api 请求，挡掉 DNS rebinding 与"别的网页偷偷调你的本地服务" */
function sameOriginOk(req) {
  const host = req.headers.host || "";
  const hostName = host.split(":")[0].toLowerCase();
  const localHostNames = ["127.0.0.1", "localhost", "[::1]", "::1"];
  if (!localHostNames.includes(hostName)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;                    // 本机脚本 / 直接 fetch 没有 Origin
  try {
    const o = new URL(origin);
    return localHostNames.includes(o.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));

  if (url.pathname.startsWith("/api/") && !sameOriginOk(req)) {
    return json(res, 403, { error: { message: "只允许本机页面访问该接口。" } });
  }

  if (url.pathname === "/api/health") {
    // L1：只放开 GET / HEAD（HEAD 是 V4 用例期望保留的行为）
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: { message: "仅支持 GET" } });
    }
    return json(res, 200, { ok: true, app: "prompt-studio", defaults: envDefaults, storeProblem: storeProblem || "" });
  }
  if (url.pathname === "/api/relay") {
    if (req.method !== "POST") return json(res, 405, { error: { message: "仅支持 POST" } });
    return handleRelay(req, res);
  }
  if (url.pathname === "/api/profiles" || url.pathname.startsWith("/api/profiles/")) {
    return handleProfiles(req, res, url);
  }
  if (url.pathname.startsWith("/api/relay/")) {
    if (req.method !== "POST") return json(res, 405, { error: { message: "仅支持 POST" } });
    return handleRelayById(req, res, decodeURIComponent(url.pathname.slice("/api/relay/".length)));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: { message: "仅支持 GET" } });
  return serveStatic(req, res, url.pathname);
}

// A single bad request must never take the whole server down.
const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("[prompt-studio] 请求处理失败:", (err && err.stack) || err);
    try {
      // B10：未预期异常只给一句人话，内部解析位置/堆栈只留在服务端日志里
      if (!res.headersSent) json(res, 500, { error: { message: "服务端处理请求时出了点意外，详细信息已打到服务端日志，请把日志发我。" } });
      else res.end();
    } catch {}
  });
});

process.on("unhandledRejection", (err) => {
  console.error("[prompt-studio] 未处理的 Promise 异常（已忽略，服务继续运行）:", (err && err.message) || err);
});
process.on("uncaughtException", (err) => {
  console.error("[prompt-studio] 未捕获异常（已忽略，服务继续运行）:", (err && err.message) || err);
});

const MAX_PORT_TRIES = 20;

function openInBrowser(url) {
  if (process.env.NO_OPEN === "1") return;
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch {}
}

/** 占用端口的到底是不是另一个 Prompt Studio？用它自己的 /api/health 判断 */
async function anotherPromptStudioIsRunning(port) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 900);
    const resp = await fetch("http://" + HOST + ":" + port + "/api/health", { signal: ac.signal });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const j = await resp.json().catch(() => null);
    return Boolean(j && j.ok === true && (j.app === "prompt-studio" || (j.defaults && typeof j.defaults === "object")));
  } catch {
    return false;
  }
}

function printBanner(url) {
  if (!storeProblem) {
    try {
      if (seedFromEnv(loadStore())) console.log("  首次启动：已按环境变量铺好接口配置");
    } catch (err) {
      console.warn("[prompt-studio] 铺种失败（不影响启动）：" + ((err && err.message) || err));
    }
  }
  console.log("");
  console.log("  Prompt Studio   " + url);
  console.log("  静态目录        " + ROOT);
  console.log("  环境变量 Key    " + (envDefaults.hasKey
    ? KEY_SOURCES.filter((n) => process.env[n]).join(" / ") + "（按 Base URL 自动匹配）"
    : "无（在页面内填写即可）"));
  console.log("");
  console.log("  这个窗口就是服务本身：关掉它，页面上的生成就会报「连不上本地服务」。");
  console.log("  按 Ctrl+C 结束。");
  console.log("");
}

/**
 * 启动：端口被占用时不再直接退出。
 *   1) 占用者是另一个 Prompt Studio → 直接打开它，然后本进程退出（双击第二次的最佳体验）；
 *   2) 占用者是别的程序 → 自动往后找一个空闲端口，并在窗口里打印实际地址。
 */
async function startServer(port, attempt) {
  // 注意：不能用 listen(port, host, cb) —— 失败的尝试会把 cb 留在 'listening' 上，
  // 下一次成功时两个回调都会触发，横幅就会打印两遍。改为显式挂/摘监听器。
  const onListening = () => {
    const actual = server.address().port;
    const url = "http://" + HOST + ":" + actual;
    if (attempt > 0) console.log("  （原端口被占用，本次实际使用 " + actual + "）");
    printBanner(url);
    openInBrowser(url);
  };
  const onError = async (err) => {
    server.removeListener("listening", onListening);
    if (!err || err.code !== "EADDRINUSE") {
      console.error(err);
      process.exit(1);
    }
    const occupiedUrl = "http://" + HOST + ":" + port;
    if (await anotherPromptStudioIsRunning(port)) {
      console.log("");
      console.log("  已经有一个 Prompt Studio 运行在 " + occupiedUrl + " 了，不会重复启动。");
      console.log("  已为你打开那个页面。");
      console.log("  如果确实要再起一个实例：set PORT=6000 && node server.mjs");
      console.log("");
      openInBrowser(occupiedUrl);
      process.exit(0);
    }
    if (attempt >= MAX_PORT_TRIES) {
      console.error("");
      console.error("  端口 " + (port - attempt) + " 往后 " + MAX_PORT_TRIES + " 个端口都被别的程序占用了。");
      console.error("  请自己指定一个空闲端口：set PORT=6000 && node server.mjs");
      console.error("");
      process.exit(1);
    }
    console.log("  端口 " + port + " 被其他程序占用，自动换到 " + (port + 1) + " …");
    startServer(port + 1, attempt + 1);
  };
  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, HOST);
}

startServer(PORT, 0);