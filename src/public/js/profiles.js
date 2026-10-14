/**
 * 模型接口管理（前端）：列表 / 表单 / 启停 / 测试 / 选择。
 * 配置与密钥都存在本地服务端（data/profiles.json，密钥用 Windows DPAPI 加密），
 * 浏览器这边只看得到掩码。
 */
import { PROTOCOLS } from "./adapters.mjs";

let hooks = { log: () => {}, onChange: () => {} };

export const profileState = {
  list: [],
  encryption: "",
  store: "",
  editingId: null,
  selected: new Set(),
  mode: "single",      // single | compare
  available: false,    // 本地服务是否支持接口管理
};

const $ = (sel) => document.querySelector(sel);

export function initProfiles(options) {
  hooks = { ...hooks, ...options };
  const protocolSelect = $("#pfProtocol");
  protocolSelect.innerHTML = PROTOCOLS.map((p) => '<option value="' + p.id + '">' + p.label + "</option>").join("");
  protocolSelect.addEventListener("change", () => {
    $("#profileHint").textContent = (PROTOCOLS.find((p) => p.id === protocolSelect.value) || {}).note || "";
    $("#pfStyleRow").hidden = protocolSelect.value !== "openai";
  });

  $("#addProfile").addEventListener("click", () => openForm(null));
  $("#pfCancel").addEventListener("click", closeForm);
  $("#pfSave").addEventListener("click", () => saveForm());
  $("#pfDelete").addEventListener("click", () => {
    if (profileState.editingId) removeProfile(profileState.editingId);
  });
  $("#pfTest").addEventListener("click", async () => {
    const id = await saveForm(true);
    if (id) testProfile(id);
  });

  for (const btn of document.querySelectorAll("#runMode button")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }
}

/* ------------------------------------------------------------------ */
/* 与服务端交互                                                        */
/* ------------------------------------------------------------------ */

async function api(path, options) {
  const resp = await fetch(path, options);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!resp.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 200) || ("HTTP " + resp.status);
    throw new Error(msg);
  }
  return json;
}

export async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    profileState.list = data.profiles || [];
    profileState.encryption = data.encryption || "";
    profileState.store = data.store || "";
    profileState.available = true;
  } catch (err) {
    profileState.available = false;
    profileState.list = [];
  }
  ensureSelection();
  renderProfiles();
  hooks.onChange();
  return profileState.list;
}

function ensureSelection() {
  const enabledIds = profileState.list.filter((p) => p.enabled).map((p) => p.id);
  for (const id of [...profileState.selected]) {
    if (!enabledIds.includes(id)) profileState.selected.delete(id);
  }
  if (!profileState.selected.size && enabledIds.length) {
    profileState.selected.add(enabledIds[0]);
    if (profileState.mode === "compare" && enabledIds[1]) profileState.selected.add(enabledIds[1]);
  }
}

export function selectedProfiles() {
  return profileState.list.filter((p) => profileState.selected.has(p.id) && p.enabled);
}

export function setMode(mode) {
  profileState.mode = mode === "compare" ? "compare" : "single";
  const enabled = profileState.list.filter((p) => p.enabled).map((p) => p.id);
  if (profileState.mode === "single") {
    const first = [...profileState.selected][0] || enabled[0];
    profileState.selected = new Set(first ? [first] : []);
  } else {
    for (const id of enabled.slice(0, 2)) profileState.selected.add(id);
  }
  renderProfiles();
  for (const btn of document.querySelectorAll("#runMode button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === profileState.mode));
  }
  hooks.onChange();
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export function renderProfiles() {
  const host = $("#profileList");
  if (!profileState.available) {
    host.innerHTML = '<p class="placeholder">多接口管理需要本地服务。请用 <code>node server.mjs</code> 启动后刷新页面；直接以 file:// 打开时只能用单接口模式。</p>';
    return;
  }
  if (!profileState.list.length) {
    host.innerHTML = '<p class="placeholder">还没有接口。点右上角「+ 新增」添加第一个模型。</p>';
    return;
  }
  const compare = profileState.mode === "compare";
  host.innerHTML = profileState.list.map((p) => {
    const picked = profileState.selected.has(p.id);
    const test = p.lastTest
      ? '<span class="pf-test" data-ok="' + p.lastTest.ok + '">' + (p.lastTest.ok ? "✓ " + p.lastTest.ms + "ms" : "✕ 失败") + "</span>"
      : '<span class="pf-test" data-ok="">未测试</span>';
    // 侧栏只有 320px，环境变量名太长会被截断 —— 标签保持短，全名放 title 里
    const keyBadge = p.hasKey
      ? '<span class="pf-key" data-ok="1" title="密钥已加密保存在本机">已配置 ' + escapeHtml(p.keyHint || "") + "</span>"
      : (p.keyFromEnv
        ? '<span class="pf-key" data-env="1" title="' + escapeHtml(p.keyFromEnv) + '">环境变量</span>'
        : '<span class="pf-key" data-ok="0" title="这个接口还没有可用的密钥">未配置 Key</span>');
    return '<div class="pf-item" data-id="' + p.id + '" data-picked="' + picked + '" data-off="' + (!p.enabled) + '">' +
      '<button type="button" class="pf-pick" data-act="pick" aria-pressed="' + picked +
        '" title="' + (compare ? "加入对比" : "选它生成") +
        '" aria-label="' + (compare ? "把这个接口加入多模型对比" : "选这个接口来生成") + '：' + escapeHtml(p.name) + '"></button>' +
      '<div class="pf-main">' +
        '<div class="pf-name">' + escapeHtml(p.name) + '<span class="pf-badge">' + escapeHtml(protocolLabel(p.protocol)) + "</span></div>" +
        '<div class="pf-sub">' + escapeHtml(p.modelId || "未填模型 ID") + " " + keyBadge + " " + test + "</div>" +
      "</div>" +
      '<div class="pf-actions">' +
        '<button type="button" class="ghost tiny" data-act="toggle" title="' + (p.enabled ? "禁用" : "启用") + '">' + (p.enabled ? "启用中" : "已禁用") + "</button>" +
        '<button type="button" class="ghost tiny" data-act="test">测试</button>' +
        '<button type="button" class="ghost tiny" data-act="edit">编辑</button>' +
      "</div></div>";
  }).join("");

  for (const item of host.querySelectorAll(".pf-item")) {
    const id = item.dataset.id;
    item.addEventListener("click", (e) => {
      const act = (e.target.closest("button") || {}).dataset ? e.target.closest("button").dataset.act : "";
      if (act === "toggle") return toggleProfile(id);
      if (act === "test") return testProfile(id);
      if (act === "edit") return openForm(id);
      pickProfile(id);
    });
  }
}

function protocolLabel(id) {
  const found = PROTOCOLS.find((p) => p.id === id);
  return found ? found.label : id;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 选中某个接口（单模型替换选中；对比模式切换选中）—— 托盘列表与输入卡浮层共用 */
export function pickProfile(id) {
  const profile = profileState.list.find((p) => p.id === id);
  if (!profile || !profile.enabled) {
    hooks.log && hooks.log("这个接口已禁用，先启用它。", "error");
    return;
  }
  if (profileState.mode === "compare") {
    if (profileState.selected.has(id)) profileState.selected.delete(id);
    else profileState.selected.add(id);
  } else {
    profileState.selected = new Set([id]);
  }
  renderProfiles();
  hooks.onChange();
}

/* ------------------------------------------------------------------ */
/* 表单                                                                */
/* ------------------------------------------------------------------ */

export function openForm(id) {
  const form = $("#profileForm");
  profileState.editingId = id;
  const p = profileState.list.find((x) => x.id === id);
  $("#pfName").value = p ? p.name : "";
  $("#pfProtocol").value = p ? p.protocol : "openai";
  $("#pfBaseUrl").value = p ? p.baseUrl : "";
  $("#pfModelId").value = p ? p.modelId : "";
  $("#pfApiKey").value = "";
  $("#pfApiKey").placeholder = p && p.hasKey ? "已保存 " + p.keyHint + "，留空 = 不改动" : "sk-...（加密保存在本机）";
  $("#pfTemperature").value = p && p.params && p.params.temperature !== undefined ? p.params.temperature : "";
  $("#pfMaxTokens").value = p && p.params && p.params.maxTokens ? p.params.maxTokens : "";
  $("#pfNote").value = p ? p.note || "" : "";
  $("#pfApiStyle").value = p && p.apiStyle ? p.apiStyle : "chat";
  $("#pfStyleRow").hidden = (p ? p.protocol : "openai") !== "openai";
  $("#profileHint").textContent = (PROTOCOLS.find((x) => x.id === $("#pfProtocol").value) || {}).note || "";
  form.hidden = false;
  syncFormMode();
  $("#pfName").focus();
}

export function closeForm() {
  profileState.editingId = null;
  $("#profileForm").hidden = true;
}

/** 表单当前处于「新增」还是「编辑」——按钮文案、删除键、Key 提示都跟着它走 */
function syncFormMode() {
  const p = profileState.list.find((x) => x.id === profileState.editingId) || null;
  $("#pfDelete").hidden = !p;
  $("#pfSave").textContent = p ? "保存" : "新增";
  $("#pfTest").textContent = "保存并测试";
  $("#pfApiKey").placeholder = p && p.hasKey
    ? "已保存 " + p.keyHint + "，留空 = 不改动"
    : "sk-...（加密保存在本机）";
}

/**
 * 读一个数字输入框。
 * 返回 null 表示「用户清空了 → 请服务端删掉这个参数」（B7：以前用 undefined，会被 JSON.stringify 丢掉）。
 * 返回 undefined 表示「格式/范围不合法 → 不要提交」（L10）。
 */
function readNumberInput(sel, min, max, label) {
  const raw = $(sel).value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    hooks.log && hooks.log(label + " 要填数字，比如 0.7。", "error");
    return undefined;
  }
  if (n < min || n > max) {
    hooks.log && hooks.log(label + " 要在 " + min + " 到 " + max + " 之间。", "error");
    return undefined;
  }
  return n;
}

async function saveForm(quiet) {
  const temperature = readNumberInput("#pfTemperature", 0, 2, "temperature");
  const maxTokens = readNumberInput("#pfMaxTokens", 1, 200000, "max tokens");
  if (temperature === undefined || maxTokens === undefined) return null;

  const payload = {
    name: $("#pfName").value.trim(),
    protocol: $("#pfProtocol").value,
    baseUrl: $("#pfBaseUrl").value.trim(),
    modelId: $("#pfModelId").value.trim(),
    apiStyle: $("#pfApiStyle").value,
    note: $("#pfNote").value.trim(),
    params: { temperature, maxTokens },
  };
  const key = $("#pfApiKey").value.trim();
  if (key) payload.apiKey = key;
  if (!payload.name) { hooks.log && hooks.log("给这个接口起个名字。", "error"); return null; }
  if (!payload.baseUrl) { hooks.log && hooks.log("Base URL 不能为空。", "error"); return null; }

  try {
    const editing = profileState.editingId;
    const data = await api(editing ? "/api/profiles/" + editing : "/api/profiles", {
      method: editing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!quiet) hooks.log && hooks.log("已保存接口「" + data.profile.name + "」。", "ok");

    // B1：无论 quiet 与否，都把状态切到「正在编辑刚保存的这条」。
    // 以前 quiet 分支不回写 editingId，表单停在「新增」，于是「保存并测试」连点两次就会建两条同名接口。
    profileState.editingId = data.profile.id;
    await loadProfiles();
    if (!editing) profileState.selected = new Set([data.profile.id]);
    syncFormMode();
    if (!quiet) closeForm();
    renderProfiles();
    hooks.onChange();
    return data.profile.id;
  } catch (err) {
    hooks.log && hooks.log("保存失败：" + err.message, "error");
    return null;
  }
}

export async function removeProfile(id) {
  const p = profileState.list.find((x) => x.id === id);
  if (!confirm('删除接口「' + (p ? p.name : id) + '」？')) return;
  try {
    await api("/api/profiles/" + id, { method: "DELETE" });
    hooks.log && hooks.log("已删除接口。", "ok");
    profileState.editingId = null;
    $("#profileForm").hidden = true;
    await loadProfiles();
  } catch (err) {
    hooks.log && hooks.log("删除失败：" + err.message, "error");
  }
}

async function toggleProfile(id) {
  const p = profileState.list.find((x) => x.id === id);
  if (!p) return;
  try {
    await api("/api/profiles/" + id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    hooks.log && hooks.log("已" + (p.enabled ? "禁用" : "启用") + "「" + p.name + "」。", "");
    await loadProfiles();
  } catch (err) {
    hooks.log && hooks.log("切换失败：" + err.message, "error");
  }
}

export async function testProfile(id) {
  hooks.log && hooks.log("正在测试接口…", "");
  try {
    const r = await api("/api/profiles/" + id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    hooks.log && hooks.log((r.ok ? "连接成功" : "连接失败") + "：" + r.message + "（" + r.ms + "ms）", r.ok ? "ok" : "error");
    await loadProfiles();
  } catch (err) {
    hooks.log && hooks.log("测试失败：" + err.message, "error");
  }
}
