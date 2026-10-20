# Prompt Studio 桌面版（Electron）

把 `standalone/index.html` 包成 Windows 桌面应用：自带 Chromium 运行时、不需要装 Node.js、双击就有独立窗口。

## 它做了什么

- 进程内起一个 `127.0.0.1:8787` 的本地代理，规则与 `standalone/server.mjs` 完全一致（`POST /api/proxy` 转发 + `GET /` 返回页面）。
  页面判断 `LOCAL_PROXY` 要求端口正好是 8787，所以 Electron 版也必须占用这个端口。
- 8787 被别的程序占用时：如果对方也是 Prompt Studio（探测页面标题）就直接复用；否则退到 8790 并弹窗提示「代理不可用，云端接口可能被 CORS 拦」。
- 站外链接一律交给系统浏览器打开，应用窗口不会变成浏览器。
- 单实例运行；菜单里保留重新载入 / 缩放 / 全屏 / 开发者工具 / 关于。
- API Key、设置、历史都落在 Electron 自己的 userData 目录，卸载时默认保留（`deleteAppDataOnUninstall: false`）。

## 本地跑

```bash
npm install
npm start          # 自动把 ../standalone/index.html 同步过来再启动
```

## 打包安装包

```bash
npm install
npm run dist       # 产物：dist/PromptStudio-Setup-1.5.2.exe
```

产物是 NSIS 安装包：可选安装目录、写桌面与开始菜单快捷方式、带卸载项。

### 两个环境相关的坑

1. **`ELECTRON_RUN_AS_NODE=1`**：如果你的终端里有这个环境变量（很多 Electron 宿主会设），`electron .` 会退化成纯 Node 并报 `Cannot find module 'electron'`。启动前清掉它：
   `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .`
2. **`winCodeSign` 解压失败**（`Cannot create symbolic link ... darwin/lib/*.dylib`）：那是 macOS 符号链接，Windows 普通权限解不出来。
   所以 `package.json` 里设了 `signAndEditExecutable: false`，改用 `afterPack.cjs` 调用本地 `rcedit` 写图标与版本信息；`rcedit` 缺失时自动跳过（只是 exe 图标变成 Electron 默认图标，功能不受影响）。

## 目录

| 文件 | 说明 |
| --- | --- |
| `main.js` | 主进程：本地代理、窗口、菜单、单实例、端口退让 |
| `afterPack.cjs` | 打包后写 exe 图标与版本信息 |
| `icon.ico` / `icon.png` | 应用与安装器图标（256/128/64/48/32/16 六帧） |
| `index.html` | 构建时从 `../standalone/index.html` 同步，不入库 |
