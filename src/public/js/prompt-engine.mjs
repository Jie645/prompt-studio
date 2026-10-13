/**
 * Prompt Studio - prompt engineering engine
 * Shared by the browser UI (and usable from Node).
 *
 * Pipeline: analyze -> compose -> critique -> revise
 * Grounded in the "enhance-prompt" pipeline (assess gaps, raise specificity,
 * structure the output, match intent instead of over-designing) and in
 * writing-for-agents practice (unambiguous scope, explicit output contract,
 * MUST/SHOULD separation, self-check).
 */

import { collectVariables } from "./vars.mjs";

export const TARGETS = [
  { id: "general", label: "通用对话助手", note: "ChatGPT / Claude / Gemini 这类通用助手", guidance:
      "The prompt runs in a general-purpose chat assistant. Optimise for a single high-quality answer: role, task, context, constraints, output contract. No tool use assumed." },
  { id: "writing", label: "写作 / 内容", note: "文章、文案、报告、剧本", guidance:
      "The prompt drives a human-facing writing task. Specify voice, reader, angle, structure, length in words, and what to do with facts the writer cannot know. Include the anti-patterns to avoid." },
  { id: "code", label: "代码 / 工程", note: "写代码、改代码、评审", guidance:
      "The prompt drives a coding assistant. Specify stack and versions, the files or interfaces in play, the definition of done, how to verify, and the constraints on scope (do not touch unrelated code). Ask for the smallest correct change." },
  { id: "agent", label: "Agent / 工具调用", note: "多步执行、调用工具、自动化", guidance:
      "The prompt drives an autonomous agent with tools. Specify the tools and when to use them, the decision procedure, the stopping condition, how to report progress, what needs human approval, and how to fail safely. Prefer explicit loops over vague autonomy." },
  { id: "image", label: "图像生成", note: "Midjourney / SD / GPT-Image", guidance:
      "The prompt drives an image model. Describe subject, action, setting, composition and camera, lighting, palette, medium and style, level of detail; add what to avoid. Use concrete visual nouns rather than mood adjectives alone." },
  { id: "data", label: "数据 / 结构化输出", note: "抽取、分类、转换", guidance:
      "The prompt drives a structured extraction or transformation. Specify the exact schema, the allowed values, the handling of missing or ambiguous records, the units and formats, and one worked example of input to output." },
  { id: "video", label: "视频 / 分镜", note: "短视频、分镜脚本", guidance:
      "The prompt drives a video or storyboard task. Specify shot-by-shot structure, duration, aspect and platform, on-screen text, voice-over, and the hook in the first seconds." },
];

export const LENGTHS = [
  { id: "compact", label: "精简", words: "about 120-200 words", note: "把骨架留下，删掉可推断的细节" },
  { id: "standard", label: "标准", words: "about 250-450 words", note: "完整结构，主次分明" },
  { id: "thorough", label: "详尽", words: "about 600-900 words", note: "加入示例、边界情况与自检清单" },
];

export const LANGS = [
  { id: "auto", label: "跟随输入" },
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];

export const DEFAULT_CONFIG = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiStyle: "chat",
  apiKey: "",
  temperature: 0.7,
};

export const PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", apiStyle: "chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5", apiStyle: "responses" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", apiStyle: "chat" },
  { id: "ollama", label: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", apiStyle: "chat" },
  { id: "custom", label: "自定义", baseUrl: "", model: "", apiStyle: "chat" },
];
/* ------------------------------------------------------------------ */
/* Upstream request adapter                                            */
/* ------------------------------------------------------------------ */

export function toUpstreamBody(opts) {
  const { apiStyle = "chat", model, system, user, temperature = 0.7, stream = false, jsonMode = false } = opts;
  if (apiStyle === "responses") {
    const body = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],
    };
    if (stream) body.stream = true;
    if (jsonMode) body.text = { format: { type: "json_object" } };
    return body;
  }
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
  };
  if (stream) body.stream = true;
  if (jsonMode) body.response_format = { type: "json_object" };
  return body;
}


/* ------------------------------------------------------------------ */
/* 阶段 0 - 沟通澄清（生成前，多轮往返）                                 */
/* ------------------------------------------------------------------ */

export const ASK_SYSTEM = `你是「需求澄清官」。在别人动手写提示词之前，你负责把需求问清楚 —— 你只提问，不写提示词。

每轮怎么做:
- 只问 1 到 3 个最关键的问题，按「对最终提示词质量的影响」从大到小排。绝对不要一次抛一张长清单，那会让用户疲劳。
- 优先问这些维度：使用场景 / 目标平台；目标受众；期望的风格、语气、篇幅；输出格式（要不要结构化、要不要 {{变量}} 占位符）；有没有参考样例或反面案例；硬性约束（禁忌词、必须包含的要素、合规要求）。
- 已经问过的、用户已经答过的，不要再问第二遍。用户跳过或说"你决定"的，就把它当成已定，用你的默认值补进 facts，并在 facts 里标明是默认。
- 不要复述用户的话，不要寒暄，不要解释你在做什么。问题的措辞要短、要具体，能一眼看懂。
- 每轮只输出 JSON，不要有任何额外文字。

什么时候结束:
- 当且仅当「凭这些信息已经能写出高质量提示词」时，把 status 设为 "enough"，questions 留空，并在 ready 里写一句确认（例如「信息已收集完毕，可以点击生成」）。
- 信息仍然不足就 status = "asking"，并在 missing 里列出还缺什么（一行一个，给用户看）。
- 不要为了凑轮次而提问，也不要因为不好意思而提前收尾：该问的必须问到，够了就果断结束。

facts 的维护（最重要的一条）:
- facts 是你对「已经确定的信息」的累积快照，键用简短中文名（使用场景 / 目标受众 / 风格语气 / 篇幅 / 输出格式 / 参考样例 / 硬性约束 / 其他）。
- 只写用户明确说过的，或用户明确授权你决定的。绝不编造。
- 每轮返回的是**完整快照**，不是增量。

返回的 JSON 结构:
{
  "status": "asking" | "enough",
  "questions": [ { "id": "platform", "question": "这条提示词最终在哪个平台用？", "options": ["小红书", "公众号", "抖音"], "why": "决定语气和篇幅" } ],
  "facts": { "使用场景": "小红书", "目标受众": "25-35 岁职场女性" },
  "missing": ["还缺：篇幅要求", "还缺：禁忌词"],
  "ready": "只有在 status = enough 时给一句确认"
}
questions 最多 3 条，options 可有可无（有就给 2 到 4 个可点的候选）。`;

export function buildAskCall(input, chat) {
  const target = TARGETS.find((t) => t.id === input.target) || TARGETS[0];
  const transcript = (chat.messages || []).map((m) =>
    (m.role === "assistant" ? "【AI 提问】" : "【用户回答】") + m.text
  ).join("\n");
  return {
    stage: "ask",
    jsonMode: true,
    stream: false,
    temperature: 0.4,
    system: chat.metaAsk || ASK_SYSTEM,
    user: [
      "# 原始要求",
      input.raw.trim(),
      "",
      "# 工作台设置",
      "目标运行时: " + target.label,
      "详细程度: " + label(LENGTHS, input.length),
      "输出语言: " + label(LANGS, input.language),
      input.extra ? "用户补充要求: " + input.extra.trim() : "",
      "",
      "# 已经确定的补充信息（上一轮快照）",
      Object.keys(chat.facts || {}).length ? JSON.stringify(chat.facts, null, 2) : "（还没有）",
      "",
      "# 到目前为止的沟通记录",
      transcript || "（这是第一轮，请开始提问）",
      "",
      "当前是第 " + ((chat.round || 0) + 1) + " 轮，最多 " + (chat.maxRounds || 4) + " 轮。",
      (chat.round || 0) + 1 >= (chat.maxRounds || 4)
        ? "已经到轮次上限：请直接把 status 设为 enough，用你判断的默认值补全 facts。"
        : "按上面的规则决定继续提问还是收尾。",
    ].filter(Boolean).join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Stage 1 - analyze                                                   */
/* ------------------------------------------------------------------ */

const ANALYZE_SYSTEM = `You are the analysis half of a prompt-engineering workbench. You receive a rough, possibly vague request written by a non-expert and return the plan for the prompt that should be written.

How to work:
- Read the request as intent, not as a spec. Find the real job behind it.
- Infer aggressively, but never invent facts that would mislead the final prompt. Every guess goes into "assumptions".
- Decide the runtime the prompt will actually run in (general chat assistant, coding agent, tool-calling agent, image model, data pipeline, ...). Everything downstream must fit that runtime.
- Choose techniques from evidence for THIS request. Never list a technique you cannot justify. Prefer three real ones over eight decorative ones.
- Raise concrete gaps: missing audience, missing success criteria, missing format, missing input material, missing hard constraints. For anything that would materially change the prompt, ask one question and always offer a sensible default so the user can accept it in one click.
- Do not write the prompt yet. Do not add commentary outside the JSON.

Return JSON only, exactly this shape:
{
  "goal": "one sentence: what the generated prompt must make the model achieve",
  "taskType": "e.g. 内容创作 / 代码实现 / 数据分析 / 图像生成 / 多步自动化 / 决策辅助",
  "domain": "subject area",
  "runtime": { "kind": "general|writing|code|agent|image|data|video", "notes": "how the runtime changes the prompt" },
  "audience": "who consumes the model output",
  "inputMaterials": ["what the model will be given at run time"],
  "deliverable": { "format": "...", "length": "...", "language": "..." },
  "constraints": ["hard requirements already implied by the request"],
  "assumptions": ["defaults you are filling in, phrased so the user can correct them"],
  "gaps": ["what the original request failed to specify"],
  "questions": [ { "question": "...", "options": ["...", "..."], "default": "..." } ],
  "techniques": [ { "name": "...", "why": "why this request needs it" } ],
  "outline": [ { "section": "...", "purpose": "what this part of the final prompt does" } ],
  "qualityBar": ["what a good result looks like, checkable"],
  "risks": [ { "risk": "...", "mitigation": "..." } ]
}
At most 3 questions, each answerable in one click. Keep every string short. Use the user's language for values.`;

export function buildAnalyzeCall(input) {
  return {
    stage: "analyze",
    jsonMode: true,
    temperature: 0.3,
    stream: false,
    system: ANALYZE_SYSTEM,
    user: [
      "# 原始请求",
      input.raw.trim(),
      "",
      "# 工作台设置",
      "目标运行时: " + label(TARGETS, input.target),
      "详细程度: " + label(LENGTHS, input.length),
      "输出语言: " + label(LANGS, input.language),
      input.extra ? "用户补充要求: " + input.extra.trim() : "",
    ].filter(Boolean).join("\n"),
  };
}
/* ------------------------------------------------------------------ */
/* Stage 2 - compose                                                   */
/* ------------------------------------------------------------------ */

export const COMPOSE_SYSTEM = `You are a senior prompt architect. You turn a request plus its analysis into the final, production-grade prompt. You write for a model, not for a human reader.

Non-negotiables:
- Output the prompt itself and nothing else. No greeting, no "here is your prompt", no explanation, no code fences around the whole answer.
- Write for the declared runtime. If the runtime is an agent with tools, say which tool to use and when, what to do before acting, and when to stop. If it is an image model, talk in visual nouns. Do not give an agent prompt for a chat task.
- Precision beats volume. Every sentence must change what the model does. Delete anything the model would have done anyway.
- Separate MUST from SHOULD. Make constraints checkable: numbers, names, boundaries, formats.
- Phrase every rule as the target behaviour, not as a prohibition. "Write one-line comments" beats "do not write long comments": a ban drags the banned thing into the model's attention. Keep a prohibition only as a hard guardrail you cannot state positively, and pair it with the positive target so attention lands on what to do.
- Delete no-ops. Any sentence the model already obeys by default (be accurate, be helpful, follow the format below) costs attention and buys nothing. Cut the whole sentence, not a few words.
- Anchor a behaviour with one leading word the model already knows (tight, relentless, proof, neutral), then reuse that same token wherever the behaviour applies.
- End each step on a completion criterion that is checkable, and exhaustive where the task allows it ("all four fields present", "every rule applied").
- Define the output contract explicitly: structure, length, ordering, tone, and what to do when information is missing.
- Put anything the user will vary at run time in {{snake_case}} placeholders and list them at the end.
- Never restate the request verbatim. Upgrade it: add the audience, the success criteria, the boundaries and the failure behaviour that the user left implicit.
- Respect the analysis: use its constraints, resolve its gaps with its assumptions, and cover its quality bar.
- Match the requested output language exactly.
- Keep the prompt self-contained: a fresh model with no memory of this conversation must be able to run it.

Use this skeleton, dropping any section the runtime does not need:
1. One-line objective
2. Role / identity and what it is accountable for
3. Context and known inputs (mark assumptions the user should verify)
4. Steps: numbered, ordered, each ending in a concrete action or artifact
5. Rules: what to do (stated positively), the few hard guardrails, and the edge cases to handle
6. Output format: exact shape, length, ordering, and behaviour when data is missing
7. Example or micro-example, only if it materially stabilises the output
8. Self-check the model runs before answering

For an image prompt, replace 3-8 with: subject and action, setting, composition and camera, light, palette, medium and style, detail level, and what to avoid.`;

export function buildComposeCall(input, analysis, chat) {
  const length = LENGTHS.find((l) => l.id === input.length) || LENGTHS[1];
  const target = TARGETS.find((t) => t.id === input.target) || TARGETS[0];
  return {
    stage: "compose",
    jsonMode: false,
    stream: true,
    temperature: 0.6,
    system: COMPOSE_SYSTEM,
    user: [
      "# 原始请求",
      input.raw.trim(),
      input.extra ? "\n# 用户补充要求\n" + input.extra.trim() : "",
      "",
      "# 分析结果",
      JSON.stringify(analysis, null, 2),
      chat && chat.facts && Object.keys(chat.facts).length
        ? "\n# 与用户沟通后确定的补充信息（必须全部体现在提示词里）\n" + JSON.stringify(chat.facts, null, 2)
        : "",
      chat && (chat.messages || []).some((m) => m.role === "user")
        ? "\n# 沟通记录（用户的原始表述，措辞偏好以这里为准）\n" +
          chat.messages.map((m) => (m.role === "assistant" ? "【AI】" : "【用户】") + m.text).join("\n")
        : "",
      "",
      "# 生成要求",
      "输出语言: " + langInstruction(input.language),
      "详细程度: " + length.label + "（" + length.words + "）；" + length.note,
      "运行时要点: " + target.guidance,
      "只输出提示词本身。",
    ].join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Stage 3 - critique                                                  */
/* ------------------------------------------------------------------ */

const CRITIQUE_SYSTEM = `You are a strict prompt reviewer. You are given a raw request and a generated prompt. Grade the prompt, not the request.

Grade each axis 0-10 and be willing to give low scores. A 9+ means you would ship it unchanged.
- specificity: concrete nouns, numbers, names instead of generic adjectives
- structure: sections in an order a model can actually execute
- constraints: MUST / SHOULD / NEVER stated so they are checkable
- outputContract: format, length, ordering, and missing-data behaviour are pinned down
- grounding: it uses the real subject matter instead of placeholders like "your topic"
- runtimeFit: it matches the runtime it will run in (chat vs agent vs image vs data)
- ambiguity: reverse-scored; 10 means a fresh model cannot misread it
- transferability: it stays correct when the {{variables}} change
- positiveFraming: rules are written as the target behaviour; prohibitions are rare and each is paired with the positive target
- noNoOps: it contains no instruction the model already obeys by default

Rules: cite the offending fragment in "where". Never invent a problem to look thorough, and never praise vaguely. If the prompt is already strong, say so and return an empty issue list.

Return JSON only:
{
  "scores": { "specificity": 0, "structure": 0, "constraints": 0, "outputContract": 0, "grounding": 0, "runtimeFit": 0, "ambiguity": 0, "transferability": 0, "positiveFraming": 0, "noNoOps": 0 },
  "total": 0,
  "verdict": "one or two sentences",
  "issues": [ { "severity": "blocker|major|minor", "where": "quoted fragment", "problem": "...", "fix": "..." } ],
  "topFix": "the single change with the largest payoff",
  "stopRecommendation": "continue|stop",
  "stopReason": "when you say stop, the one concrete reason"
}
"total" is the mean of the ten axes rounded to one decimal. Say "stop" when another rewrite round would only shuffle wording; say "continue" when a specific, nameable defect still exists. Use the user's language for prose.`;

export function buildCritiqueCall(input, prompt) {
  return {
    stage: "critique",
    jsonMode: true,
    stream: false,
    temperature: 0.2,
    system: CRITIQUE_SYSTEM,
    user: [
      "# 原始请求",
      input.raw.trim(),
      "",
      "# 目标运行时",
      label(TARGETS, input.target),
      "",
      "# 待评审的提示词",
      prompt,
    ].join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Stage 4 - revise                                                    */
/* ------------------------------------------------------------------ */

const REVISE_SYSTEM = `You are the same prompt architect. Apply the reviewer's findings and return the corrected prompt.

- Fix every blocker and major issue. Take the minor ones when the fix costs nothing.
- Keep what already worked. This is a revision, not a rewrite for its own sake.
- Stay inside the same runtime, language and length budget as before.
- Output the final prompt only. No changelog, no commentary, no code fences around the whole answer.`;

export function buildReviseCall(input, prompt, critique, round) {
  return {
    stage: "revise",
    jsonMode: false,
    stream: true,
    temperature: 0.5,
    system: REVISE_SYSTEM,
    user: [
      "# 原始请求",
      input.raw.trim(),
      "",
      "# 当前提示词",
      prompt,
      "",
      "# 评审意见",
      JSON.stringify(critique, null, 2),
      "",
      "第 " + (round || 1) + " 轮修订：只改评审点到的地方，已经达标的部分原样保留，不要为了改动而改动。",
      "输出语言: " + langInstruction(input.language),
      "只输出修订后的提示词。",
    ].join("\n"),
  };
}
/* ------------------------------------------------------------------ */
/* Local fallback (no API key needed)                                  */
/* ------------------------------------------------------------------ */

const HINTS = [
  { re: /(代码|函数|脚本|报错|重构|接口|模块|python|javascript|java|go|rust|sql|code|function|debug|refactor)/i, target: "code", type: "代码与工程", steps: ["阅读相关文件与现有约定", "写出最小可运行的改动", "说明如何验证结果"] },
  { re: /(分镜|视频|剪辑|短视频|镜头|video|storyboard|shot)/i, target: "video", type: "视频与分镜", steps: ["先定钩子与前 3 秒", "按镜头拆解画面与台词", "标注时长、画面比例与字幕"] },
  { re: /(画|图|海报|插画|封面|场景|image|illustration|poster|midjourney|stable diffusion)/i, target: "image", type: "图像生成", steps: ["描述主体与动作", "补充构图、光线与材质", "指定媒介与风格，并写明避免项"] },
  { re: /(数据|表格|统计|抽取|分类|清洗|报表|dataset|extract|classify|etl)/i, target: "data", type: "数据与结构化输出", steps: ["明确输入字段与单位", "给出目标结构与取值范围", "规定缺失与异常的处理方式"] },
  { re: /(自动|批量|定时|工作流|agent|自动化|流水线|workflow)/i, target: "agent", type: "多步自动化", steps: ["列出可用工具与使用时机", "定义决策顺序与停止条件", "约定失败与需人工确认的情况"] },
  { re: /(写|文案|文章|报告|邮件|方案|总结|教程|write|copy|article|report|email|summary)/i, target: "writing", type: "写作与内容", steps: ["锁定读者与写作目的", "规划结构与篇幅", "统一语气并删掉套话"] },
];

export function localEnhance(input) {
  const raw = input.raw.trim();
  const hint = HINTS.find((h) => h.re.test(raw)) || { target: "general", type: "通用任务", steps: ["确认目标与读者", "给出可执行的步骤", "按要求的结构输出"] };
  const wanted = input.target && input.target !== "general" ? input.target : hint.target;
  const target = TARGETS.find((t) => t.id === wanted) || TARGETS[0];
  const length = LENGTHS.find((l) => l.id === input.length) || LENGTHS[1];
  const topic = raw.replace(/\s+/g, " ").slice(0, 80);
  const zh = input.language !== "en";

  const lines = zh ? [
    "# 目标",
    "把下面的需求做成一份可直接交付的成果：" + topic,
    "",
    "# 角色",
    "你是" + target.label + "方向的资深从业者，对结果质量负责，不做未经验证的假设。",
    "",
    "# 已知输入",
    "- 原始需求：{{request}}",
    input.extra ? "- 补充要求：" + input.extra.trim() : "- 补充要求：{{extra}}",
    "- 你自行补齐的假设要显式标注出来。",
    "",
    "# 执行步骤",
    ...hint.steps.map((s, i) => (i + 1) + ". " + s),
    (hint.steps.length + 1) + ". 输出前对照「自检」逐条确认。",
    "",
    "# 约束",
    "- 必须：只使用输入中给出的信息，缺信息就说明缺口，不要编造。",
    "- 必须：结论与格式一一对应，不添加未被要求的章节。",
    "- 应当：每个判断都带可核查的数字、名称或边界。",
    "- 绝不（硬护栏）：编造未提供的事实。",
    "",
    "# 输出格式",
    "Markdown，分节作答，先给结论再给依据。" + length.note + "。",
    "",
    "# 自检",
    "- 需求里的每一句都得到回应了吗？",
    "- 有没有可核查的数字、名称或边界？",
    "- 别人不追问就能直接用吗？",
    "",
    "# 变量",
    "{{request}} 原始需求；{{extra}} 补充要求。",
  ] : [
    "# Objective",
    "Produce a directly usable deliverable for: " + topic,
    "",
    "# Role",
    "You are a senior " + target.label + " practitioner accountable for quality. Do not make unverified assumptions.",
    "",
    "# Known inputs",
    "- Raw request: {{request}}",
    input.extra ? "- Additional requirements: " + input.extra.trim() : "- Additional requirements: {{extra}}",
    "- Label every assumption you fill in.",
    "",
    "# Steps",
    ...hint.steps.map((s, i) => (i + 1) + ". " + s),
    (hint.steps.length + 1) + ". Run the self-check below before answering.",
    "",
    "# Rules",
    "- MUST: use only the information given; state gaps instead of inventing facts.",
    "- MUST: match the output format exactly; add no unrequested sections.",
    "- SHOULD: every claim carries a checkable number, name or boundary.",
    "- NEVER (hard guardrail): invent a fact that was not provided.",
    "",
    "# Output format",
    "Markdown, conclusion first then reasoning. " + length.note,
    "",
    "# Self-check",
    "- Does every part of the request get an answer?",
    "- Are there checkable numbers, names or boundaries?",
    "- Can someone use this without asking a follow-up question?",
    "",
    "# Variables",
    "{{request}} raw request; {{extra}} additional requirements.",
  ];

  const prompt = lines.join("\n");
  return {
    prompt,
    analysis: {
      goal: zh ? "把粗略需求升级为可执行的提示词" : "Upgrade a rough request into an executable prompt",
      taskType: hint.type,
      domain: zh ? "未指定" : "unspecified",
      runtime: { kind: target.id, notes: zh ? "离线规则模式（未调用模型）" : "offline rule mode (no model call)" },
      audience: zh ? "提示词的最终使用者" : "the prompt's end user",
      inputMaterials: ["{{request}}"],
      deliverable: { format: "Markdown", length: length.label, language: zh ? "中文" : "English" },
      constraints: zh ? ["不编造事实", "格式对齐", "去除套话"] : ["no invented facts", "format-aligned", "no filler"],
      assumptions: zh ? ["按关键词推断任务类型：" + hint.type] : ["task type inferred from keywords: " + hint.type],
      gaps: zh ? ["缺少读者、成功标准与输入材料的具体说明"] : ["reader, success criteria and input material are unspecified"],
      questions: [],
      techniques: zh
        ? [{ name: "角色设定", why: "稳定语气与判断标准" }, { name: "输出契约", why: "让结果可直接使用" }, { name: "自检清单", why: "减少遗漏" }]
        : [{ name: "Role prompting", why: "stabilises judgement" }, { name: "Output contract", why: "makes the result usable" }, { name: "Self-check", why: "reduces omissions" }],
      outline: (zh ? ["目标", "角色", "已知输入", "执行步骤", "约束", "输出格式", "自检", "变量"] : ["Objective", "Role", "Known inputs", "Steps", "Rules", "Output format", "Self-check", "Variables"]).map((section) => ({ section, purpose: "" })),
      qualityBar: zh ? ["可核查", "可直接使用", "无套话"] : ["checkable", "directly usable", "no filler"],
      risks: [],
      offline: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function label(list, id) {
  const found = list.find((x) => x.id === id);
  return found ? found.label : id;
}

function langInstruction(language) {
  if (language === "en") return "English";
  if (language === "zh") return "简体中文";
  return "与原始请求一致的语言（原始请求为中文时用简体中文）";
}

export function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch {}

  // L3：以前用 indexOf("{") + lastIndexOf("}")，正文里先出现一个花括号（比如「提示 {注意} 然后是 {...}」）
  // 就会取到一段非法片段。这里改成括号配平扫描，逐个候选起点试到能解析为止。
  for (let start = cleaned.indexOf("{"); start >= 0; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {}
          break;   // 这个起点不行，换下一个 '{'
        }
      }
    }
  }
  return null;
}

// B8：变量范围只有一份定义（vars.mjs），自定义模板与变量页不会再各认一套
export function extractVariables(prompt) {
  return collectVariables(prompt);
}

export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk * 1.05 + rest / 4));
}