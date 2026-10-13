/**
 * 针对性回归：B2（配置损坏静默丢数据）、B3（密钥经命令行外泄）
 *
 *   node tests/test-regressions.mjs
 *
 * 这两条没法在被测服务的常规运行中验证，需要额外起一个实例来制造故障。
 * 用法与 run-all.mjs 一致（会自己起一个临时实例，跑完还原数据文件）。
 *
 *   环境变量： PORT2 临时实例端口（默认 5191）、KEEP=1 不还原
 *
 * 预期（整改前）：两条都 FAIL —— 这正是要修的。
 * 预期（整改后）：两条都 PASS。
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(TESTS_DIR, "..");
const SRC = resolve(PKG_DIR, "src");
const DATA_FILE = resolve(SRC, "data", "profiles.json");
const DATA_DIR = resolve(SRC, "data");
const PORT2 = Number(process.env.PORT2 || 5191);
const NODE = process.execPath;

const results = [];
function rec(id, name, pass, detail) {
  results.push({ id, name, pass });
  console.log((pass ? "PASS " : "FAIL ") + id.padEnd(5) + " " + name + (pass ? "" : "  -> " + String(detail).slice(0, 400)));
}

const backup = existsSync(DATA_FILE) ? readFileSync(DATA_FILE, "utf8") : null;
const children = [];
function cleanup() {
  for (const c of children) { try { c.kill(); } catch {} }
  if (!process.env.KEEP && backup !== null) writeFileSync(DATA_FILE, backup, "utf8");
}
process.on("exit", cleanup);

function launchServer(env) {
  const child = spawn(NODE, ["server.mjs"], {
    cwd: SRC,
    env: { ...process.env, PORT: String(PORT2), HOST: "127.0.0.1", NO_OPEN: "1",
      PROMPT_STUDIO_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  child.__log = () => log;
  children.push(child);
  return child;
}
async function waitHttp(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE2 = "http://127.0.0.1:" + PORT2;

/* ================================================================== */
/* R1 — B2：profiles.json 损坏时的行为                                  */
/* ================================================================== */
{
  const MARKER = "p_marker_must_survive";
  const broken = '{"version":1,"profiles":[{"id":"' + MARKER + '","name":"我的生产接口","baseUrl":"https://api.deepseek.com/v1","modelId":"deepseek-flash"}'; // 故意截断，缺右括号
  // 清掉上一轮可能留下的备份
  for (const f of (existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : [])) {
    if (/corrupt/i.test(f)) { try { const { unlinkSync } = await import("node:fs"); unlinkSync(resolve(DATA_DIR, f)); } catch {} }
  }
  writeFileSync(DATA_FILE, broken, "utf8");

  const srv = launchServer({});
  await waitHttp(BASE2 + "/api/health");

  // 1) 读取：不应把「文件损坏」静默当成「空空如也」
  let apiState = "";
  try {
    const r = await fetch(BASE2 + "/api/profiles");
    const t = await r.text();
    apiState = r.status + " " + t.slice(0, 120);
  } catch (e) { apiState = "fetch 失败 " + e.message; }

  // 2) 写一次（新增接口），看原来的数据会不会被覆盖掉
  let writeOk = false;
  try {
    const r = await fetch(BASE2 + "/api/profiles", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "写操作探测", baseUrl: "https://api.deepseek.com/v1", modelId: "x" }),
    });
    writeOk = r.ok;
  } catch {}

  await sleep(300);
  const nowRaw = existsSync(DATA_FILE) ? readFileSync(DATA_FILE, "utf8") : "";
  const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : [];
  const corruptBackups = files.filter((f) => /corrupt/i.test(f));
  const log = srv.__log();

  const kept = nowRaw.includes(MARKER);
  const backupHasIt = corruptBackups.some((f) => { try { return readFileSync(resolve(DATA_DIR, f), "utf8").includes(MARKER); } catch { return false; } });
  const warned = /损坏|解析失败|corrupt|无法解析|JSON 解析|备份/i.test(log);
  const apiNotSilly = !/^2\d\d .*"profiles":\[\]/.test(apiState);

  rec("R1a", "B2：损坏的 profiles.json 被备份成 corrupt-* 文件", corruptBackups.length > 0, "data/ 目录：" + JSON.stringify(files));
  rec("R1b", "B2：备份文件里保住了原来的接口数据", backupHasIt, "备份内容未包含 " + MARKER);
  rec("R1c", "B2：读取接口不把「文件损坏」静默当成「没有配置」", apiNotSilly, "接口返回：" + apiState);
  rec("R1d", "B2：服务端有明确告警日志", warned, "日志片段：" + JSON.stringify(log.slice(0, 220)));
  rec("R1e", "B2：发生一次写操作后原数据没被覆盖（或已安全备份）", (writeOk ? kept : true) || backupHasIt,
    "写操作成功=" + writeOk + " | 主文件仍含标记=" + kept + " | 备份含标记=" + backupHasIt + " | 主文件=" + JSON.stringify(nowRaw.slice(0, 160)));

  srv.kill();
  await sleep(300);
}

/* ================================================================== */
/* R2 — B3：密钥是否出现在子进程命令行上                                 */
/* ================================================================== */
{
  const PLAIN = "sk-cmdline-probe-abcdef1234567890";
  const B64 = Buffer.from(PLAIN, "utf8").toString("base64");

  writeFileSync(DATA_FILE, JSON.stringify({ version: 1, profiles: [] }, null, 2), "utf8");
  const srv = launchServer({});
  await waitHttp(BASE2 + "/api/health");

  // 后台高频抓取所有 powershell.exe 的命令行
  const seen = new Set();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | ForEach-Object { $_.CommandLine }"],
          { encoding: "utf8", timeout: 8000, windowsHide: true });
        for (const line of out.split(/\r?\n/)) if (line.trim()) seen.add(line);
      } catch {}
      await sleep(20);
    }
  })();

  // 触发 8 次保存（每次都会走一遍 protectKey）
  for (let i = 0; i < 8; i++) {
    try {
      await fetch(BASE2 + "/api/profiles", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "命令行探测" + i, baseUrl: "https://api.deepseek.com/v1", modelId: "x", apiKey: PLAIN }),
      });
    } catch {}
    await sleep(60);
  }
  await sleep(500);
  polling = false;
  await poll;

  const hitPlain = [...seen].filter((l) => l.includes(PLAIN));
  const hitB64 = [...seen].filter((l) => l.includes(B64));
  const leaked = hitPlain.length > 0 || hitB64.length > 0;

  rec("R2a", "B3：密钥明文不出现在任何 powershell 命令行上", hitPlain.length === 0, hitPlain.length + " 条命中：" + JSON.stringify(hitPlain.slice(0, 2).map((s) => s.slice(0, 200))));
  rec("R2b", "B3：密钥 base64 也不出现在命令行上", hitB64.length === 0, hitB64.length + " 条命中：" + JSON.stringify(hitB64.slice(0, 2).map((s) => s.slice(0, 200))));

  // 顺便看加密方案是否是伪加密
  let scheme = "";
  try {
    const r = await fetch(BASE2 + "/api/profiles");
    const j = await r.json();
    scheme = (j.profiles && j.profiles[0] && j.profiles[0].keyScheme) || "";
  } catch {}
  rec("R3", "B3：加密方案随接口返回（便于前端提示未加密）", Boolean(scheme), "keyScheme=" + JSON.stringify(scheme));
  console.log("        （参考：本机 DPAPI " + (scheme === "dpapi" ? "可用，用的是真加密" : "不可用或未启用，落盘为 base64 伪加密") + "，scheme=" + scheme + "）");

  srv.kill();
  await sleep(300);
}

/* ================================================================== */
console.log("─".repeat(58));
const failed = results.filter((r) => !r.pass);
console.log("针对性回归：总计 " + results.length + "，通过 " + (results.length - failed.length) + "，失败 " + failed.length);
if (failed.length) {
  console.log("整改前这里全红是正常的；改完 B2/B3 后应当全绿。");
}
cleanup();
process.exit(0);
