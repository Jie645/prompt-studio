# Prompt Studio · 提示词工作台

一句话输入 → 一份可以直接交付的高级提示词。**本地运行、零依赖、双击即用**。

它不是「把话丢给模型说一句帮我优化」，而是把提示词工程拆成一条可检查的流水线：

```
写一句需求
   │
   ├─ ① 沟通补充   模型先问 1–3 个关键问题，最多 4 轮；每轮产出「已收集信息」快照
   │                （信息没齐不写提示词 —— 生成永远由你点按钮触发）
   ├─ ② 解析需求   读出真实意图、挑出缺口、给出可采纳的默认值
   ├─ ③ 撰写提示词 目标 / 角色 / 已知输入 / 步骤 / 规则 / 输出格式 / 自检 / {{变量}}
   └─ ④ 自评 + 迭代 十维打分 → 按停止规则改写复评 → 保留得分最高的那一版
```

## 功能

- **多模型**：任意多个接口并存，支持 OpenAI 兼容 / Anthropic / 自定义模板三种协议
- **并发对比**：勾选多个接口并行生成，选项卡切换查看，逐列标注耗时与 token
- **失败隔离**：某一路挂了只影响它自己那一列，其它列照常出字
- **深度模式**：带停止规则的迭代（达标 9 分 / 提升不足 0.3 分 / 评委判定可停 / 3 轮上限）
- **变量填充**：把 `{{变量}}` 填好后实时拼出最终提示词，一键复制
- **导出文档**：把需求 + 沟通补充 + 提示词 + 变量整理成 Markdown，走系统「另存为」
- **历史会话**：沟通记录与生成结果关联保存，可回看可重载
- **两套元提示词**：沟通提问用、生成写作用，都能在界面上编辑
- **无 Key 也能用**：内置规则模式先搭出结构骨架
- **纯视觉主题**：Deep Space Glass / Energy Flow（深空玻璃 + 青紫能量流）

## 快速开始

需要 **Node.js 18+**，没有任何 npm 依赖。

```bash
cd src
node server.mjs        # 启动后浏览器会自动打开
```

Windows 上也可以直接双击 `src/run.cmd`。

### 单文件版（推荐个人使用）

`standalone/index.html` 是**零依赖单文件**版本：双击即用，离线规则无需任何运行时；接模型时把同一目录的 `run.cmd` 一起双击，它会起一个本地代理绕过浏览器 CORS。

### 桌面安装包

在 [Releases](https://github.com/Jie645/prompt-studio/releases) 下载 `PromptStudio-Setup-1.5.3.exe`，双击安装即可（自带 Node 运行时，不需要另装 Node.js），安装后桌面会有「Prompt Studio」快捷方式。

**端口说明**：默认 5178。若被别的程序占用会**自动往后找空闲端口**并在窗口里打印实际地址；若检测到已经有一个 Prompt Studio 在跑，会直接帮你打开那个页面，不会重复启动。

### 模型接口

左侧「03 模型接口」支持增删改查 / 启停 / 连接测试，密钥用 **Windows DPAPI** 加密存在 `src/data/profiles.json`，**只回传掩码、不回传明文**；DPAPI 不可用时页面顶部会出现醒目的未加密警告。

首次启动若检测到环境变量里的 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`，会自动铺好对应接口。

## 回归测试

```bash
node tests/run-all.mjs            # 4 批共 137 项
node tests/test-regressions.mjs   # B2/B3 故障注入专项 8 项
```

当前状态：**137/137 全绿**、专项 **8/8 全绿**。基线日志在 `tests/基线-*.log`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/server.mjs` | 全部后端：静态托管、接口 CRUD、按 id 转发、DPAPI 加解密、端口退让 |
| `src/public/js/prompt-engine.mjs` | 提示词引擎：两套元提示词、四阶段、宽松 JSON 解析、离线规则模式 |
| `src/public/js/adapters.mjs` | 协议适配层（前后端共用，保持环境无关） |
| `src/public/js/vars.mjs` | 变量占位符的唯一定义 |
| `src/public/js/app.js` | 前端主控：状态机、流水线编排、选项卡、导出、历史 |
| `src/public/js/profiles.js` | 接口配置表单与增删改查交互 |
| `src/public/styles.css` | 全部样式（单文件、无构建） |
| `tests/` | 回归用例 + 模拟上游 + 基线日志 |
| `docs/` | 整改任务书、原始 Bug 报告、界面升级提示词与交付说明 |

## 设计原则

- **零依赖**：只用 Node 内置模块，前端原生 ESM，不需要构建步骤
- **密钥不外流**：明文永不出服务端；加密失败会在界面上显式告警
- **数据不静默丢失**：配置损坏时备份成 `profiles.json.corrupt-<时间戳>` 并报错，不假装空配置
- **指令写正面**：生成提示词时优先写成目标行为而不是禁令
## 更新日志

### 桌面版 1.5.3（2026-10-20）· 主进程 AbortError 崩溃修复

安装版在流式生成中途断开连接时，会弹出 `A JavaScript error occurred in the main process / AbortError: This operation was aborted` 的模态框，关掉之前窗口无响应。

**根因**：本地代理 `res.on("close", () => controller.abort())` 中止上游后，`Readable.fromWeb(...).pipe(res)` 没有 `error` 监听，`AbortError` 变成主进程未捕获异常。

**修复**（仅 `desktop/main.js`，页面未改动）

- 断连先置 `clientGone`，`abort()` 前判 `signal.aborted` 并包 `try/catch`
- `.pipe()` 换 `pipeline()`，流错误与 `AbortError` / `ERR_STREAM_PREMATURE_CLOSE` 统一静默消化，不再写已关闭的 socket
- `handleProxy` 补 `.catch()`，HTTP server 增加 `clientError` 处理
- 主进程新增 `uncaughtException` / `unhandledRejection` 兜底：写 `%APPDATA%\prompt-studio\error.log`（512KB 轮转），不再弹框

**验证**：单元级并排复现（旧实现 1 次 `AbortError` → 新实现 0 次）；真实 Electron 端到端连续断开 3 次，进程存活、代理继续服务、日志零新增；1.5.2 下同一脚本会阻塞至超时。

详细说明：[`docs/06-桌面版崩溃修复-v1.5.3.md`](docs/06-桌面版崩溃修复-v1.5.3.md)

### Standalone 1.5.2（2026-10-20）· QA 缺陷修复

独立 QA 评测（89 条用例、16 条缺陷）后的修复版本，`standalone/index.html` 已更新到 1.5.2。

**安全**

- 历史列表属性注入（S2）：`esc()` 现在同时转义 `"` 与 `'`，需求文本无法再闭合 `aria-label` 注入事件属性
- API Key 分层存储：默认只进 `sessionStorage`（关标签页即失效），勾选「记住密钥」才写 `localStorage`；模型列表不再含明文；新增「清除全部密钥」；旧版明文自动迁移
- 增加 CSP（`object-src` / `frame-src` / `base-uri` / `form-action` 全禁用）

**功能与交互**

- 输出上限可调（2k / 4k / 8k），推理模型下限 8192；深度模式审阅遇到「只返回推理内容」会换极简指令重试一次——真实 `deepseek-flash` 深度模式由「788 字截断 + 审阅失败」变为 3017 字、4/4 步、无警告
- 沟通弹窗 `✕` / Esc / 遮罩统一为「退出沟通并保留已输入需求」，「这轮跳过」独立保留
- 代理 5xx 时保留上游错误原因，与直连错误分两段展示，不再被最后的 `404 not found` 覆盖
- 云端地址缺 Key 直接拦截保存并聚焦密钥框，状态胶囊显示「缺 API Key」
- 「生成设置」三行各自独立显示当前值；多模型对比的模型数量与实际请求统一（`min(4, 可用数)`）；`mode` 纳入持久化
- 文案与细节：回退提示去重、fallback 不显示耗时徽标、截断字数准确、首字 <100ms 显示 `<0.1s`、空模型 ID 走必填校验

详细说明：[`docs/05-QA缺陷修复说明-v1.5.2.md`](docs/05-QA缺陷修复说明-v1.5.2.md)　基线评测：[`docs/QA测试报告_1.5.1_基线评测.md`](docs/QA测试报告_1.5.1_基线评测.md)

### Standalone 1.4.0

动态多轮追问、四阶段流水线、多模型并发对比。
