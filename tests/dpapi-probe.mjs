import { execFileSync } from "node:child_process";
for (const [label, args] of [
  ["powershell 版本", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"]],
]) {
  try {
    const r = execFileSync("powershell", args, { encoding: "utf8", timeout: 20000, windowsHide: true });
    console.log(label + " -> OK: " + r.trim());
  } catch (e) {
    console.log(label + " -> 失败: " + (e.code || e.message));
  }
}
const prelude = "Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;";
try {
  const r = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    prelude + "$b=[Text.Encoding]::UTF8.GetBytes('probe');$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Convert]::ToBase64String($p)"],
    { encoding: "utf8", timeout: 30000, windowsHide: true });
  console.log("DPAPI probe -> 输出长度 " + r.trim().length + " 前缀 " + r.trim().slice(0, 20));
} catch (e) {
  console.log("DPAPI probe -> 失败: " + (e.code || e.message));
}
