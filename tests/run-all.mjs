/**
 * 一键跑回归测试。
 *
 *   node tests/run-all.mjs
 *
 * 它会自动：
 *   1. 备份 src/data/profiles.json，并把它清空成空配置
 *   2. 用「清空 API Key 环境变量」的环境启动被测服务（否则会自动铺种接口，干扰离线模式用例）
 *   3. 启动模拟上游模型服务
 *   4. 依次跑 4 个用例脚本
 *   5. 停掉子进程，并把 profiles.json 还原成运行前的样子
 *
 * 可用环境变量：
 *   PORT      被测服务端口，默认 5190
 *   MOCK_PORT 模拟上游端口，默认 5199
 *   KEEP=1    跑完不还原 src/data/profiles.json
 *
 * 注意：本脚本直接对 src/ 跑（不复制副本），因为测试只会写 data/profiles.json，跑完会还原。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(TESTS_DIR, "..");
const SRC = resolve(PKG_DIR, "src");
const DATA_FILE = resolve(SRC, "data", "profiles.json");
const PORT = Number(process.env.PORT || 5190);
const MOCK_PORT = Number(process.env.MOCK_PORT || 5199);
const NODE = process.execPath;
const EMPTY = JSON.stringify({ version: 1, profiles: [] }, null, 2);

if (!existsSync(resolve(SRC, "server.mjs"))) {
  console.error("找不到 " + SRC + "/server.mjs —— 请把本脚本放在 <包目录>/tests/ 下运行。");
  process.exit(1);
}

/* 1. 备份并清空数据文件 */
let backup = null;
try { backup = readFileSync(DATA_FILE, "utf8"); } catch {}
mkdirSync(resolve(SRC, "data"), { recursive: true });
writeFileSync(DATA_FILE, EMPTY, "utf8");
console.log("已备份并清空 " + DATA_FILE);

/* 子进程管理 + 收尾 */
const children = [];
let done = false;
function cleanup() {
  if (done) return;
  done = true;
  for (const c of children) { try { c.kill(); } catch {} }
  if (!process.env.KEEP) {
    try {
      if (backup === null) writeFileSync(DATA_FILE, EMPTY, "utf8");
      else writeFileSync(DATA_FILE, backup, "utf8");
      console.log("已还原 " + DATA_FILE);
    } catch (e) { console.log("还原失败，请手动恢复：" + e.message); }
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

function launch(args, opts) {
  const child = spawn(NODE, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => {
    const s = String(d);
    if (/Error|EADDRINUSE|throw/.test(s)) process.stderr.write("[子进程] " + s);
  });
  children.push(child);
  return child;
}

async function waitHttp(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* 2. 被测服务（清空 Key 环境变量，避免自动铺种干扰用例） */
launch(["server.mjs"], {
  cwd: SRC,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", NO_OPEN: "1",
    PROMPT_STUDIO_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "" },
});

/* 3. 模拟上游 */
launch([resolve(TESTS_DIR, "mock-upstream.mjs")], {
  cwd: TESTS_DIR,
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
});

const base = "http://127.0.0.1:" + PORT;
const mock = "http://127.0.0.1:" + MOCK_PORT;
if (!(await waitHttp(base + "/api/health"))) { console.error("被测服务没能起来：" + base); process.exit(1); }
if (!(await waitHttp(mock + "/_last"))) { console.error("模拟上游没能起来：" + mock); process.exit(1); }
console.log("服务就绪：" + base + " | 模拟上游：" + mock + "\n");

/* 4. 依次跑用例 */
const suites = ["test-api.mjs", "test-extra.mjs", "test-verify.mjs", "test-front.mjs"];
for (const suite of suites) {
  console.log("─".repeat(58));
  console.log("▶ " + suite);
  const code = await new Promise((res) => {
    const p = spawn(NODE, [resolve(TESTS_DIR, suite)], {
      cwd: PKG_DIR,
      env: { ...process.env, PS_BASE: base, PS_MOCK: mock, PS_ROOT: SRC },
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("close", res);
  });
  if (code !== 0) console.log("  （脚本退出码 " + code + "，看上面的 PASS/FAIL 行即可）");
}

console.log("─".repeat(58));
console.log("跑完了。请对照 01-整改任务书.md 第五节的验收标准判断。");
console.log("还有 B2 / B3 专项要跑（单独跑，不要和本脚本同时进行）：");
console.log("    node tests/test-regressions.mjs");

/* 显式收尾：子进程的 stdio 管道会让事件循环一直不空，不能只靠 'exit' 事件 */
cleanup();
process.exit(0);
