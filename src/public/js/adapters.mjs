/**
 * 协议适配层 —— 服务端与浏览器共用同一份（保持纯函数，不碰 DOM / Node API）。
 * 新增一家模型 = 在这里加一个 adapter，编排层与界面都不用动。
 */

import { variableRegExp } from "./vars.mjs";

export const PROTOCOLS = [
  { id: "openai", label: "OpenAI 兼容", note: "DeepSeek / Kimi / 通义 / OpenRouter / 本地 Ollama 等绝大多数" },
  { id: "anthropic", label: "Anthropic", note: "Claude 官方 API：x-api-key + anthropic-version" },
  { id: "custom", label: "自定义模板", note: "自己写 URL 与请求体模板，响应按 OpenAI 格式解析" },
];

function trimSlash(url) { return String(url || "").trim().replace(/\/+$/, ""); }

/** 模板渲染失败（不是合法 JSON / 变量把结构撑坏）时抛这个，服务端据此回 400 而不是 500 */
export class TemplateError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "TemplateError";
    this.detail = detail || "";
  }
}

/**
 * B4：把值插进 JSON 模板前必须先转义。
 * 以前是原样字符串替换，用户内容里只要出现 " 或 \ 就会把模板结构撑坏，必然 500。
 * 字符串值按「JSON 字符串内容」转义（配合模板里已经写好的引号）；
 * 数字/布尔按字面量插入（模板里通常不带引号）。
 */
function jsonSafe(value) {
  if (typeof value === "string") return JSON.stringify(value).slice(1, -1);
  return String(value);
}

function renderTemplate(text, vars) {
  const map = vars || {};
  return String(text).replace(variableRegExp("g"), (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(map, key)) return whole;   // 未知变量原样留着
    const v = map[key];
    if (v === undefined || v === null) return "";
    return jsonSafe(v);
  });
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容                                                         */
/* ------------------------------------------------------------------ */

const openai = {
  id: "openai",
  endpoint(profile) {
    const base = trimSlash(profile.baseUrl);
    if (/(\/chat\/completions|\/responses|\/completions)$/.test(base)) return base;
    return base + (profile.apiStyle === "responses" ? "/responses" : "/chat/completions");
  },
  headers(profile, apiKey) {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
      ...(profile.params && profile.params.headers ? profile.params.headers : {}),
    };
  },
  body(profile, req) {
    const p = profile.params || {};
    if (profile.apiStyle === "responses") {
      const body = {
        model: profile.modelId,
        input: [
          { role: "system", content: [{ type: "input_text", text: req.system }] },
          { role: "user", content: [{ type: "input_text", text: req.user }] },
        ],
      };
      if (req.stream) body.stream = true;
      if (req.json) body.text = { format: { type: "json_object" } };
      return body;
    }
    const body = {
      model: profile.modelId,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (p.temperature !== undefined && p.temperature !== null && p.temperature !== "") body.temperature = Number(p.temperature);
    if (p.maxTokens) body.max_tokens = Number(p.maxTokens);
    if (p.topP) body.top_p = Number(p.topP);
    if (req.stream) body.stream = true;
    if (req.json) body.response_format = { type: "json_object" };
    return body;
  },
  delta(json) {
    if (typeof json?.delta === "string") return json.delta;
    const choice = json?.choices && json.choices[0];
    if (choice) return (choice.delta && choice.delta.content) || null;
    return null;
  },
  text(json) {
    if (typeof json?.output_text === "string" && json.output_text) return json.output_text;
    const choice = json?.choices && json.choices[0];
    if (choice) return (choice.message && choice.message.content) || choice.text || "";
    if (Array.isArray(json?.output)) {
      return json.output.flatMap((o) => o.content || []).map((part) => part.text || "").join("");
    }
    return "";
  },
  usage(json) {
    const u = json?.usage;
    if (!u) return undefined;
    return {
      inputTokens: u.prompt_tokens ?? u.input_tokens,
      outputTokens: u.completion_tokens ?? u.output_tokens,
      totalTokens: u.total_tokens,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

const anthropic = {
  id: "anthropic",
  endpoint(profile) {
    const base = trimSlash(profile.baseUrl) || "https://api.anthropic.com/v1";
    return /\/messages$/.test(base) ? base : base + "/messages";
  },
  headers(profile, apiKey) {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey || "",
      "anthropic-version": (profile.params && profile.params.anthropicVersion) || "2023-06-01",
    };
  },
  body(profile, req) {
    const p = profile.params || {};
    const body = {
      model: profile.modelId,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      max_tokens: Number(p.maxTokens) || 4096,
    };
    if (p.temperature !== undefined && p.temperature !== null && p.temperature !== "") body.temperature = Number(p.temperature);
    if (p.topP) body.top_p = Number(p.topP);
    if (req.stream) body.stream = true;
    return body;
  },
  delta(json) {
    if (json?.type === "content_block_delta") return json.delta?.text ?? null;
    return null;
  },
  text(json) {
    return (json?.content || []).map((c) => c.text || "").join("");
  },
  usage(json) {
    const u = json?.usage;
    if (!u) return undefined;
    return {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    };
  },
  streamUsage(json) {
    if (json?.type === "message_delta" && json.usage) {
      return { outputTokens: json.usage.output_tokens, totalTokens: json.usage.output_tokens };
    }
    if (json?.type === "message_start" && json.message?.usage) {
      return { inputTokens: json.message.usage.input_tokens };
    }
    return undefined;
  },
};

/* ------------------------------------------------------------------ */
/* 自定义模板                                                          */
/* ------------------------------------------------------------------ */

const custom = {
  id: "custom",
  endpoint(profile) { return trimSlash(profile.baseUrl); },
  headers(profile, apiKey) {
    const p = profile.params || {};
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
      ...(p.headers || {}),
    };
  },
  body(profile, req, vars) {
    const tpl = (profile.params && profile.params.bodyTemplate) || "";
    if (!tpl.trim()) return openai.body(profile, req);
    const merged = {
      model: profile.modelId,
      system: req.system,
      user: req.user,
      stream: req.stream,
      json: req.json,
      temperature: (profile.params || {}).temperature ?? 0.7,
      max_tokens: (profile.params || {}).maxTokens ?? 4096,
      ...(vars || {}),
    };
    let rendered;
    try {
      rendered = renderTemplate(tpl, merged);
    } catch (err) {
      throw new TemplateError("请求体模板渲染失败，检查一下占位符的写法。", err && err.message);
    }
    try {
      return JSON.parse(rendered);
    } catch (err) {
      // B10：不要回显内部解析位置，只给可操作的中文提示
      throw new TemplateError(
        "请求体模板不是合法 JSON：检查 {{user}} / {{system}} 周围的引号和逗号（内容里的引号已经被自动转义了）。",
        err && err.message
      );
    }
  },
  delta: openai.delta,
  text: openai.text,
  usage: openai.usage,
  streamUsage: openai.streamUsage,
};

export const adapters = { openai, anthropic, custom };

export function adapterFor(profile) {
  return adapters[(profile && profile.protocol) || "openai"] || adapters.openai;
}

/** 非流式整包取文本，兼容各家形态 */
export function extractText(profile, json) {
  return adapterFor(profile).text(json);
}

/** 一次 SSE data 行的增量 */
export function extractDelta(profile, json) {
  return adapterFor(profile).delta(json);
}

export function extractUsage(profile, json) {
  const adapter = adapterFor(profile);
  return (adapter.streamUsage ? adapter.streamUsage(json) : undefined) || adapter.usage(json);
}