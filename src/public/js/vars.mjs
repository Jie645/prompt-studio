/**
 * 变量占位符的唯一定义（B8）。
 * adapters.mjs（自定义模板替换）和 prompt-engine.mjs（变量页提取）都从这里 import，
 * 免得两套正则各写各的、中文变量在其中一侧静默失效。
 *
 * 规则：{{名字}} —— 支持中英文、数字、下划线、点、短横线；两端允许空格。
 */
export const VARIABLE_SOURCE = "\\{\\{\\s*([a-zA-Z0-9_.\\-\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7af]+)\\s*\\}\\}";

export function variableRegExp(flags) {
  return new RegExp(VARIABLE_SOURCE, flags || "g");
}

/** 采集文本里出现的所有变量名（去重、保持出现顺序） */
export function collectVariables(text) {
  const out = new Set();
  const re = variableRegExp("g");
  let m;
  const src = String(text == null ? "" : text);
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

/** 把 {{名字}} 换成 values 里对应的值；没给值的原样留着 */
export function replaceVariables(text, values) {
  const map = values || {};
  return String(text == null ? "" : text).replace(variableRegExp("g"), (whole, name) => {
    const v = map[name];
    return v === undefined || v === null || v === "" ? whole : String(v);
  });
}
