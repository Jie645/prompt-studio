/* 模拟上游模型服务，用来测试 Prompt Studio 的转发链路（零依赖） */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 5199);
let LAST = null;
let CRITIQUE_N = 0;
const CRITIQUE_SCORES = [7.0, 6.0, 5.0];

function systemOf(json) {
  if (!json) return "";
  if (Array.isArray(json.messages) && json.messages[0]) return String(json.messages[0].content || "");
  if (Array.isArray(json.input) && json.input[0] && Array.isArray(json.input[0].content)) {
    return json.input.map((m) => (m.content || []).map((c) => c.text || "").join("")).join("\n");
  }
  return "";
}

function stageOf(sys) {
  if (/analysis half of a prompt-engineering workbench/.test(sys)) return "analyze";
  if (/strict prompt reviewer/.test(sys)) return "critique";
  if (/same prompt architect/.test(sys)) return "revise";
  if (/senior prompt architect/.test(sys)) return "compose";
  if (/需求澄清官/.test(sys)) return "ask";
  return "other";
}

const ANALYZE_JSON = {
  goal: "让模型产出一封可直接发送的老客户邀请函",
  taskType: "内容创作", domain: "品牌活动", runtime: { kind: "writing", notes: "面向人类读者的写作任务" },
  audience: "三年以上的老客户", inputMaterials: ["活动信息"], deliverable: { format: "邮件正文", length: "300 字内", language: "中文" },
  constraints: ["不得编造嘉宾与赠品"], assumptions: ["活动在本地举办"], gaps: ["缺时间地点"],
  questions: [{ question: "活动时间地点？", options: ["稍后补充"], default: "{{date}}" }],
  techniques: [{ name: "角色设定", why: "稳定语气" }], outline: [{ section: "称呼", purpose: "建立亲近感" }],
  qualityBar: ["信息完整"], risks: [{ risk: "过度营销", mitigation: "禁用营销词" }],
};

function critiqueJson() {
  const score = CRITIQUE_SCORES[Math.min(CRITIQUE_N, CRITIQUE_SCORES.length - 1)];
  CRITIQUE_N += 1;
  return {
    scores: { specificity: score, structure: score, constraints: score, outputContract: score, grounding: score, runtimeFit: score, ambiguity: score, transferability: score, positiveFraming: score, noNoOps: score },
    total: score, verdict: "第 " + CRITIQUE_N + " 次评审，得分 " + score, 
    issues: [{ severity: "major", where: "约束段", problem: "缺少时间地点的兜底说明", fix: "补一句缺信息时的处理" }],
    topFix: "补兜底说明", stopRecommendation: "continue", stopReason: "",
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      resolve({ raw, json });
    });
  });
}

function sse(res, frames, delayMs) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= frames.length) {
      clearInterval(timer);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.write("data: " + JSON.stringify(frames[i]) + "\n\n");
    i += 1;
  }, delayMs || 5);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const { raw, json } = await readBody(req);

  if (url.pathname === "/_last") {
    const body = JSON.stringify(LAST);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(body);
  }
  if (url.pathname === "/_reset") { LAST = null; CRITIQUE_N = 0; res.writeHead(200).end("ok"); return; }

  LAST = {
    at: Date.now(), method: req.method, path: url.pathname,
    headers: { ...req.headers }, body: json, raw: raw.slice(0, 4000),
  };

  const auth = req.headers.authorization || "";
  const xkey = req.headers["x-api-key"] || "";

  // 错误注入：按 model 名触发
  const model = (json && json.model) || "";
  if (model === "err-401") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "无效的 API Key（模拟）", type: "authentication_error" } }));
  }
  if (model === "err-500-html") {
    res.writeHead(500, { "content-type": "text/html" });
    return res.end("<html><body>Internal Server Error</body></html>");
  }
  if (model === "err-badjson") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("这不是 JSON{");
  }
  if (model === "err-close") {
    return res.socket.destroy();
  }
  if (model === "err-usage-big") {
    // 超大 body 触发 2MB 上限测试用（由测试端直接发大体即可，这里不用）
  }

  const delay = Number(url.searchParams.get("delay") || 0);

  if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/custom")) {
    const stage = stageOf(systemOf(json));
    if (stage === "analyze") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(ANALYZE_JSON) } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    }
    if (stage === "critique") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(critiqueJson()) } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    }
    if (stage === "ask") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ status: "asking", questions: [{ id: "platform", question: "在哪个平台用？", options: ["小红书", "公众号"], why: "决定语气" }], facts: { 使用场景: "小红书" }, missing: ["还缺：篇幅要求"], ready: "" }) } }] }));
    }
    if (json && json.stream) {
      const label = stage === "revise" ? "【修订版】" : "【撰写版】";
      const frames = [
        { choices: [{ delta: { content: label } }] },
        { choices: [{ delta: { content: "你好" } }] },
        { choices: [{ delta: { content: "，世界" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
      ];
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return sse(res, frames, 5);
    }
    const payload = {
      id: "chatcmpl-mock", object: "chat.completion", model: model || "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "你好，世界（非流式）" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(payload));
  }

  if (url.pathname.endsWith("/responses")) {
    if (json && json.stream) {
      const frames = [
        { type: "response.output_text.delta", delta: "你" },
        { type: "response.output_text.delta", delta: "好" },
        { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } } },
      ];
      return sse(res, frames, 5);
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ output_text: "你好（Responses 非流式）", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } }));
  }

  if (url.pathname.endsWith("/messages")) {
    if (!xkey) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "缺少 x-api-key" } }));
    }
    if (json && json.stream) {
      const frames = [
        { type: "message_start", message: { usage: { input_tokens: 12 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
        { type: "message_delta", usage: { output_tokens: 2 } },
      ];
      return sse(res, frames, 5);
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ content: [{ type: "text", text: "你好（Anthropic 非流式）" }], usage: { input_tokens: 12, output_tokens: 5 } }));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("mock 404 " + url.pathname);
});

server.listen(PORT, "127.0.0.1", () => console.log("mock upstream on " + PORT));
