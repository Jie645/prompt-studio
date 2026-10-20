"use strict";

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const HOST = "127.0.0.1";
const PREFERRED_PORT = 8787;
const FALLBACK_PORT = 8790;
const INDEX_FILE = path.join(__dirname, "index.html");

/* ------------------------------------------------------------------ *
 * 主进程兜底：单个代理请求出错只记日志，不弹「JavaScript error」模态框
 * ------------------------------------------------------------------ */
let errorLogPath = null;
function logError(tag, err) {
  const text =
    "[" + new Date().toISOString() + "] " + tag + " :: " +
    ((err && (err.stack || err.message)) || String(err)) + "\n";
  console.error(text.trimEnd());
  try {
    if (!errorLogPath) errorLogPath = path.join(app.getPath("userData"), "error.log");
    const st = fs.existsSync(errorLogPath) ? fs.statSync(errorLogPath) : { size: 0 };
    if (st.size > 512 * 1024) fs.renameSync(errorLogPath, errorLogPath + ".1");
    fs.appendFileSync(errorLogPath, text);
  } catch {
    /* 日志失败不影响运行 */
  }
}
process.on("uncaughtException", (err) => {
  /* AbortError 属于「用户主动取消请求」的正常路径，直接忽略 */
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) return;
  logError("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) return;
  logError("unhandledRejection", err);
});

let mainWindow = null;
let server = null;
let activePort = PREFERRED_PORT;

/* ------------------------------------------------------------------ *
 * 本地代理：和 standalone/server.mjs 完全一致的转发规则。
 * 页面在 127.0.0.1:8787 上会判定 LOCAL_PROXY 为真，从而绕过浏览器 CORS。
 * ------------------------------------------------------------------ */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function handleProxy(req, res) {
  let raw = "";
  try {
    for await (const chunk of req) raw += chunk;
  } catch {
    /* 客户端上传途中断开，无需处理 */
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: { message: "代理请求不是有效 JSON。" } });
    return;
  }

  let target;
  try {
    target = new URL(payload.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error();
  } catch {
    sendJson(res, 400, { error: { message: "代理目标必须是 http(s) URL。" } });
    return;
  }

  /* 客户端（页面）随时可能取消：关弹窗、切轮次、关窗口都会断开连接。
     abort 之后 fetch 与其响应体都会以 AbortError 结束，必须全部吞掉，
     否则主进程未捕获异常会弹出「JavaScript error occurred」模态框。 */
  const controller = new AbortController();
  let clientGone = false;

  const abortUpstream = () => {
    if (!controller.signal.aborted) {
      try {
        controller.abort();
      } catch {
        /* 已中止 */
      }
    }
  };
  const onClientClose = () => {
    clientGone = true;
    abortUpstream();
  };

  res.on("close", onClientClose);
  /* 客户端已断开时写 socket 会触发 EPIPE/ERR_STREAM_DESTROYED，这里静默吸收 */
  res.on("error", () => {});

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: payload.headers || {},
      body: JSON.stringify(payload.body || {}),
      signal: controller.signal
    });

    if (clientGone || res.destroyed) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      return;
    }

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store"
    });

    if (upstream.body) {
      const body = Readable.fromWeb(upstream.body);
      body.on("error", () => {
        if (!res.destroyed) res.destroy();
      });
      /* pipeline 会负责 destroy，异常在 catch 里统一消化 */
      await pipeline(body, res);
    } else {
      res.end();
    }
  } catch (err) {
    const isAbort = err && (err.name === "AbortError" || err.code === "ABORT_ERR" || err.code === "ERR_STREAM_PREMATURE_CLOSE");
    if (isAbort || clientGone || res.destroyed || res.writableEnded) {
      if (!res.destroyed) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: "本地代理连接上游失败：" + ((err && err.message) || String(err)) }
      });
    } else if (!res.destroyed) {
      res.destroy();
    } else {
      logError("proxy", err);
    }
  } finally {
    res.removeListener("close", onClientClose);
  }
}

function serveIndex(res) {
  res.on("error", () => {});
  fs.readFile(INDEX_FILE, (err, buf) => {
    if (res.destroyed) return;
    if (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("index.html 读取失败：" + err.message);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": buf.length,
      "cache-control": "no-store"
    });
    res.end(buf);
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/proxy") {
        handleProxy(req, res).catch((err) => logError("handleProxy", err));
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (req.url && req.url.split("?")[0] !== "/" && req.url.split("?")[0] !== "/index.html") {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        serveIndex(res);
        return;
      }
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
    });
    s.once("error", reject);
    s.on("clientError", (err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    s.listen(port, HOST, () => {
      s.removeListener("error", reject);
      resolve(s);
    });
  });
}

function probeExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: "/", timeout: 1200 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (body.length < 4000) body += c;
      });
      res.on("end", () => resolve(body.includes("提示词工作台")));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function bootProxy() {
  try {
    server = await startServer(PREFERRED_PORT);
    activePort = PREFERRED_PORT;
    return { ok: true, port: activePort, degraded: false };
  } catch (err) {
    const busy = err && (err.code === "EADDRINUSE" || err.code === "EACCES");
    if (busy && (await probeExisting(PREFERRED_PORT))) {
      /* 8787 上已经有一个提示词工作台在跑，直接用它的代理 */
      return { ok: true, port: PREFERRED_PORT, degraded: false, reused: true };
    }
    if (!busy) {
      return { ok: false, port: PREFERRED_PORT, degraded: true, message: (err && err.message) || String(err) };
    }
    try {
      server = await startServer(FALLBACK_PORT);
      activePort = FALLBACK_PORT;
      return { ok: true, port: activePort, degraded: true };
    } catch (err2) {
      return { ok: false, port: FALLBACK_PORT, degraded: true, message: (err2 && err2.message) || String(err2) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "forceReload", label: "强制重新载入" },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { role: "toggleDevTools", label: "开发者工具" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "GitHub 仓库",
          click() {
            shell.openExternal("https://github.com/Jie645/prompt-studio");
          }
        },
        {
          label: "关于 Prompt Studio",
          click() {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: "Prompt Studio · 提示词工作台",
              detail:
                "版本 " + app.getVersion() + "\n" +
                "本地运行，输入与 API Key 只保存在本机。\n" +
                "本地代理端口：" + activePort + "\n" +
                "Electron " + process.versions.electron + "（Chromium " + process.versions.chrome + "）",
              buttons: ["好"]
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#060911",
    title: "Prompt Studio · 提示词工作台",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  /* 站外链接交给系统浏览器，避免把应用窗口变成浏览器 */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://${HOST}:${activePort}`)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`http://${HOST}:${activePort}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.jie645.promptstudio");
    buildMenu();

    const boot = await bootProxy();
    if (!boot.ok) {
      dialog.showMessageBoxSync({
        type: "error",
        title: "启动失败",
        message: "本地代理端口 8787 / 8790 都被占用，无法启动。",
        detail: (boot.message || "") + "\n\n请关闭占用端口的程序后重试。",
        buttons: ["退出"]
      });
      app.quit();
      return;
    }

    createWindow();

    if (boot.degraded) {
      setTimeout(() => {
        dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "端口 8787 被占用",
          message: "已改用 8790 端口启动，本地代理对页面不可用。",
          detail:
            "页面会走浏览器直连，部分云端接口可能被 CORS 拦下。\n" +
            "关掉占用 8787 的程序后重启本应用即可恢复代理。",
          buttons: ["知道了"]
        });
      }, 900);
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    if (server) {
      try {
        server.close();
      } catch (e) {
        /* ignore */
      }
    }
  });
}
