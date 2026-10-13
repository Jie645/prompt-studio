@echo off
cd /d "%~dp0"
title Prompt Studio
set "PROMPT_STUDIO_BASE_URL=https://api.deepseek.com/v1"
set "PROMPT_STUDIO_MODEL=deepseek-flash"
set "PROMPT_STUDIO_API_KEY="
echo.
echo   Prompt Studio 正在启动，浏览器会自动打开。
echo   若提示端口被占用，会自动换一个端口，实际地址以本窗口打印的为准。
echo   这个窗口就是服务本身，用的时候别关；关掉它就等于停止服务。
echo.
node server.mjs
if errorlevel 1 (
  echo.
  echo   启动失败。请把上面的错误信息发给开发者。
  pause >nul
)
