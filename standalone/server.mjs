import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.PROMPT_STUDIO_PORT || 8787);
const URL_BASE = `http://${HOST}:${PORT}/`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function proxy(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
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

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: payload.headers || {},
      body: JSON.stringify(payload.body || {}),
      signal: controller.signal
    });
    const headers = {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store"
    };
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: "本地代理连接上游失败：" + (err?.message || String(err)) }
      });
    } else {
      res.destroy();
    }
  }
}

function serveFile(req, res) {
  let pathname = "/index.html";
  try {
    pathname = decodeURIComponent(new URL(req.url, URL_BASE).pathname);
  } catch {}
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(ROOT, "." + pathname);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-store"
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/proxy") {
    proxy(req, res);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveFile(req, res);
    return;
  }
  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.on("error", (err) => {
  console.error("");
  console.error("Prompt Studio local proxy failed:", err.message);
  console.error("Port:", PORT);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Prompt Studio Standalone");
  console.log("Local proxy: enabled (no browser CORS restriction)");
  console.log("Open:", URL_BASE);
  console.log("Close this window to stop the proxy.");
  console.log("");
  if (process.platform === "win32" && process.env.PROMPT_STUDIO_NO_OPEN !== "1") {
    exec(`start "" "${URL_BASE}"`, { windowsHide: true });
  }
});
