"use strict";

/* 用本地 rcedit 给打包出来的 exe 写入图标与版本信息。
   这样做是为了绕开 electron-builder 在受限环境里解压 winCodeSign
   （该压缩包含 macOS 符号链接，无权限时会失败）。 */

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, "Prompt Studio.exe");
  const rcedit = path.join(__dirname, "..", "rcedit.exe");
  const ico = path.join(context.packager.projectDir, "icon.ico");

  if (!fs.existsSync(exe)) {
    console.log("afterPack: 未找到 exe，跳过图标写入:", exe);
    return;
  }
  if (!fs.existsSync(rcedit)) {
    console.log("afterPack: 未找到 rcedit，跳过图标写入");
    return;
  }

  const version = context.packager.appInfo.version;
  execFileSync(rcedit, [
    exe,
    "--set-icon", ico,
    "--set-file-version", version + ".0",
    "--set-product-version", version,
    "--set-version-string", "ProductName", "Prompt Studio",
    "--set-version-string", "FileDescription", "Prompt Studio · 提示词工作台",
    "--set-version-string", "CompanyName", "Jie645",
    "--set-version-string", "LegalCopyright", "Copyright © 2026 Jie645",
    "--set-version-string", "OriginalFilename", "Prompt Studio.exe"
  ], { stdio: "inherit" });

  console.log("afterPack: 已写入图标与版本信息", version);
};
