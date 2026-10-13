# Prompt Studio 功能测试与 Bug 排查报告

- **被测对象**：`C:\Users\Lenovo\AppData\Local\Programs\PromptStudio\`（桌面快捷方式「Prompt Studio」→ `run.cmd` → `server.mjs`）
- **测试时间**：2026-10-13
- **测试方式**：不动真实安装目录，把程序复制到隔离沙箱 `_pstest/`，自建一个「模拟上游模型服务」，用三种手段覆盖：
  1. **API 层集成测试**（Node 脚本直接打 HTTP 接口，含错误注入、并发、断连、超大请求体、路径穿越）——95 项；
  2. **前端逻辑测试**：给真实未改动的 `app.js` / `profiles.js` 注入最小 DOM 桩并 import 执行，驱动真实函数对流真实后端——42 项；
  3. **真实浏览器端到端**：Chromium 打开 `http://127.0.0.1:5190`，用真实点击走完整用户流程（含导出、复制、变量、沟通、多模型对比、全屏）——37 项 + 补充复核。
- **真实性说明**：真实安装目录 `data/profiles.json` 未被读写（时间戳仍为 17:46），全程未使用、未泄露你的真实 API Key。少数失败项已复核为「测试脚本自身问题」，下文已剔除并注明。

---

## 一、总体结论

核心链路是**可用**的，四步流水线、沟通提问、多模型对比、离线规则模式、导出、变量填充都真实跑通了。但存在 **4 个高危 / 高优先级缺陷**（1 个前端重复建接口、1 个配置损坏静默丢数据、1 个密钥经命令行明文外泄、1 个自定义模板必崩），外加 6 个中等问题和 13 个低优先级问题。

| 严重度 | 数量 | 一句话 |
| --- | --- | --- |
| 🔴 高 | 4 | 重复创建接口 / 配置损坏静默数据丢失 / 密钥上命令行 / 自定义模板遇引号必 500 |
| 🟠 中 | 6 | 回退提示被覆盖、回退后评分错位、参数清不掉、模板变量名不一致、错误信息误导、异常未分层 |
| 🟡 低 | 13 | 死代码、文档与实物不符、双重轮询、GET 有写副作用、无数字校验等 |

---

## 二、功能验证清单（哪些真的能用）

| 功能 | 结果 | 证据 |
| --- | --- | --- |
| 静态托管 / 路由 / 404 | ✅ | 首页、`.js`、`README.md` MIME 均正确 |
| 路径穿越防护 | ✅ | `…/js/../../server.mjs`、`%2f` 编码、反斜杠变体、超长 URL 全部挡住，未泄露源码与系统文件 |
| 接口配置 CRUD（增删改查） | ✅ | 新建/改名/启停/删除/未找到 404/非法 JSON 400/超 2MB 400 |
| 密钥隔离 | ✅ | 列表响应无 `keyCipher`、无明文；磁盘无明文；页面 HTML 无明文 |
| 落盘原子性 | ✅ | 临时文件 + rename，无残留 `.tmp` |
| 并发写配置 | ✅ | 并发 8 次新建全部保留（关键区同步执行，无丢更新） |
| 连接测试 | ✅ | 成功 / 上游 401 / 死地址 三种结果都正确回写 `lastTest` |
| OpenAI 兼容转发（流式 + 非流式） | ✅ | SSE 逐帧透传、`[DONE]` 保留、usage 透传 |
| Responses 风格 | ✅ | 打到 `/v1/responses`，`input` 结构正确 |
| Anthropic 协议 | ✅ | `/v1/messages` + `x-api-key` + `anthropic-version` + 顶层 `system` |
| 上游错误处理 | ✅ | 401 中文错误透传、500 HTML 包装成 JSON、中途断连返回 502 中文提示 |
| 禁用接口拦截 / 未知 id 404 | ✅ | — |
| 中文接口名不崩服务（v2 回归） | ✅ | 响应头仍为 ASCII |
| 恶意请求后服务存活 | ✅ | 40 轮坏请求并发、客户端中途 abort 后服务仍在 |
| 环境变量自动铺接口 | ✅ | 首启按 `DEEPSEEK_API_KEY` 铺出 DeepSeek 条目并标 `keyFromEnv` |
| 离线规则模式（无 Key） | ✅ | 按关键词判定任务类型，产出 445+ 字结构骨架，不发网络请求 |
| 完整四步流水线 | ✅ | 解析（JSON 解析成功）→ 撰写（流式）→ 评审 → 修订 |
| 深度模式停止规则 | ✅ | 打分 7.0 → 6.0，命中「收益不足 0.3 分」停止 |
| **保留最高分版本** | ✅（但提示丢失） | 正文确实回退到第 1 轮撰写版（见 B5/B6） |
| 多模型对比（真实浏览器） | ✅ | 2 个选项卡、各自耗时/`token`、切换正文、编辑器自动隐藏、「用这版」可用 |
| 沟通提问流程 | ✅ | 提问 → 候选答案可点 → 填进回答框 → 第 2 轮 → 点生成才产出内容 |
| 信息快照（facts） | ✅ | 页面实时展示并打包进提示词 |
| 变量页 | ✅ | 列出全部 `{{变量}}`、实时拼接「最终提示词」、可复制 |
| 导出为文档 | ✅ | 拦截另存为后校验内容含「需求 / 提示词 / 变量」与模型名 |
| 历史会话 | ✅ | 自动存档、可回看列表 |
| 元提示词模板 | ✅ | 保存 → 显示「已自定义」；恢复默认 → 「默认」 |
| 全屏编辑 / 复制反馈 | ✅ | — |
| 页面运行期报错 | ✅ | 完整流程中 `window.onerror` / `unhandledrejection` 计数 = 0 |

---

## 三、Bug 清单

### 🔴 高危

#### B1. 「保存并测试」连点两次会重复创建同名接口（前端）
- **位置**：`public/js/profiles.js` 第 37–40 行（`#pfTest` 处理器）→ 第 213–251 行 `saveForm(quiet)`
- **原因**：`#pfTest` 调用 `saveForm(true)`。`quiet=true` 时函数既不执行 `closeForm()`，也**没有把新建返回的 id 回写** `profileState.editingId`。表单因此一直停留在「新增」状态，再点一次就是再 POST 一次。
- **实测**：DOM 桩连点两次 → 新建 2 条 `重复测试`；真实浏览器里同样复现。
- **影响**：用户以为在「测试一个接口」，实际在批量复制接口配置；多出来的副本会一起参与对比模式。
- **修复**：`quiet` 分支也要 `profileState.editingId = data.profile.id`（并同步 `#pfDelete` 可见性、按钮文案）；或把「保存并测试」实现为「保存（走完整表单态回写）→ 再测试」。

```js
if (!editing) profileState.selected = new Set([data.profile.id]);
if (!quiet) closeForm();
+ else profileState.editingId = data.profile.id;   // 关键补丁
```

#### B2. `profiles.json` 损坏时静默丢数据，并被自动覆盖
- **位置**：`server.mjs` 第 156–162 行 `loadStore()`；第 189–203 行 `seedFromEnv()`
- **原因**：`loadStore()` 的 `catch {}` 把「解析失败」等同于「没有任何配置」，返回空 store；紧接着 `GET /api/profiles` 会调用 `seedFromEnv()` 并 `saveStore()` **写盘**，把原始（哪怕只是被截断的）文件彻底覆盖。全过程**没有任何日志、告警或备份**。
- **实测**：写一个被截断的 `profiles.json`（内含 1 条 `p_real`）→ 一次 GET 后文件被 2 条环境变量铺种覆盖，`p_real` 消失，服务端日志只有启动横幅。
- **影响**：断电、磁盘满、编辑器手改出错，任一种情况都会让用户所有接口配置与密钥**无声消失**。这是本报告里风险最高的数据安全项。
- **修复**：解析失败时先 `rename` 成 `profiles.json.corrupt-<时间戳>`，再返回 5xx 或明确提示；`GET` 不做写操作（铺种挪到启动时）；`saveStore` 保留上一版 `.bak`。

#### B3. API Key 以明文（仅 base64）出现在 PowerShell 命令行上；探测失败会静默降级为伪加密
- **位置**：`server.mjs` 第 108–113 行 `runPowerShell()`、第 125–133 行 `protectKey()`
- **原因**：`protectKey` 把明文 Key 的 base64 直接拼进命令行字符串：

```js
runPowerShell("$b=[Convert]::FromBase64String('" + b64 + "'); $p=[Security.Cryptography.ProtectedData]::Protect(...)")
```

  子进程命令行对**同一 Windows 账户下的任何进程**可见（本项目的 `uninstall.ps1` 自己就是用 `Win32_Process.CommandLine` 来定位进程的），也会进入 ETW / EDR / 审计日志。base64 不是加密。
- **附带问题**：`dpapiAvailable()` 探测失败（例如 PowerShell 被策略/EDR 拦住、`execFileSync` 报 `EBUSY`/`ENOENT`）时会**静默降级**为 `scheme: "base64"`，界面上只有一行小字提到「未加密」。本次测试环境正是这种状态（接口返回 `"encryption":"base64"`）。
- **实测**：磁盘文件中不含 `sk-` 明文（说明当前走的分支没有落明文），但命令行暴露路径客观存在。
- **修复**：改用 stdin 传值（`powershell -Command -` 并从 stdin 读），或改用不依赖 PowerShell 的 DPAPI 调用；探测失败时在页面顶部显著提示「密钥未加密存储」；长期看应换成机器绑定密钥 + AES-GCM。

#### B4. 「自定义模板」协议遇到含引号/反斜杠的内容必定 500
- **位置**：`public/js/adapters.mjs` 第 14–19 行 `renderTemplate()`、第 168–182 行 `custom.body()`
- **原因**：模板渲染是把 `{{user}}`、`{{system}}` 等**原样字符串替换**进一段 JSON 文本，然后 `JSON.parse`。只要用户内容里出现 `"`、`\` 或 `{{...}}`，模板结构就被撑坏，`JSON.parse` 抛异常；异常从 `handleRelayById` 冒到全局 catch，返回 `500 服务端处理请求时出错：Expected ',' or '}' after property value in JSON at position 57…`。
- **实测**：`user = 请写"你好"这两个字` → 500；同一内容用「OpenAI 兼容」协议则正常。
- **影响**：任何真实写作类需求（带引号、带花括号、带反斜杠）都会让自定义模板协议不可用；报错还把内部解析位置回显给用户。
- **修复**：`renderTemplate` 对字符串值先做 JSON 转义再插入（`JSON.stringify(v).slice(1,-1)`），或改成「先构造对象、再序列化」；同时把 `adapter.body` 包 `try/catch`，返回 400 + 中文提示。

### 🟠 中等

#### B5. 「已回退到第 N 轮」的提示会被下一条日志瞬间覆盖
- **位置**：`public/js/app.js` 第 336–349 行
- **原因**：回退后先 `log("最后一轮反而更差，已回退到第 1 轮（7.0 分）。")`，紧接着第 349 行又 `log("已完成 2 轮。停止原因：…")`。而 `log()` 是单行 `textContent` 赋值，不是日志流，前一条被立刻冲掉。
- **实测**：回退动作生效（正文是撰写版），但 `#log` 里只剩「已完成 2 轮」。
- **修复**：改成追加式日志列表（保留历史），或把回退信息合并进最后那条摘要。

#### B6. 回退后「自评徽标」与展示的版本对不上
- **位置**：`public/js/app.js` 第 337–348 行 + 第 912–934 行 `renderScoreChip()`；`buildExportDoc()` 第 468 行
- **原因**：回退只改了 `state.prompt`，`state.critique` 仍然是**最后一轮**（更差那轮）的评审。徽标与导出文档都读 `state.critique`，于是出现「正文是 7.0 分那版，徽标写着自评 6.0 · 2 轮」。
- **实测**：`#scoreChip = "自评 6.0 · 2 轮"`，而 `#promptOut` 是 7.0 分那一版（撰写版）。
- **修复**：`rounds` 里一并保存每轮的 critique，回退时把 `state.critique` 同步换成 best 轮那一份。

#### B7. 以前设过的 temperature / max tokens 永远清不掉
- **位置**：`profiles.js` 第 221–224 行（用 `undefined` 表示空）→ `server.mjs` 第 211 行 `sanitizeProfile` 的 `{ ...旧 params, ...新 params }` 合并
- **原因**：`JSON.stringify` 会丢掉值为 `undefined` 的键，服务端看到的是「没提交这个字段」，于是沿用旧值。
- **实测**：设成 0.3 → 再清空提交 → 仍然是 0.3。
- **修复**：用显式 `null`/`""` 表示清除，或前端提交完整 params 快照并整体替换。

#### B8. 「自定义模板」的变量名范围与前端 `extractVariables` 不一致
- **位置**：`adapters.mjs` 第 15 行（`[a-zA-Z0-9_]+`）vs `prompt-engine.mjs` 第 505 行（含中文、`.`、`-`）
- **原因**：两套正则各写各的。提示词里最常见的 `{{活动名称}}`、`{{user.name}}` 在变量页能识别、能填，但走自定义模板时**不会被替换**，且没有任何提示。
- **实测**：`{{活动名称}}` 原样留在请求体里。
- **修复**：抽出共用的变量正则，两边 import 同一份。

#### B9. Base URL 为空时报的是「缺少 API Key」，误导排查方向
- **位置**：`server.mjs` 第 436–439 行
- **原因**：先判 Key、后校验 URL。空 `baseUrl` 使 `isLocalHost("")` 为 false，直接命中「没有可用的 API Key……换了 Windows 账户或换机器会导致 DPAPI 解不开」。
- **实测**：把 baseUrl 设成空格 → 报的是密钥错误，与真实原因无关。
- **修复**：先校验 baseUrl 非空再查 Key；错误文案分开写。

#### B10. 异常没有分层，参数问题也回 500
- **位置**：`server.mjs` 第 426–448 行、第 491–499 行全局兜底
- **现象**：自定义模板语法错误 → 500；openai 协议 baseUrl 为空时 `openai.endpoint()` 会产出 `/chat/completions` 这种站内相对路径（`adapters.mjs` 第 27–31 行），Node fetch 抛 `Failed to parse URL`，被包装成「上游请求失败」。
- **修复**：区分「参数/模板错误（400）」「上游错误（透传状态码）」「未预期异常（500，但不回显内部解析位置）」。

### 🟡 低优先级

| 编号 | 问题 | 位置 / 证据 |
| --- | --- | --- |
| L1 | `/api/health` 不限制方法，`PUT`、`HEAD` 也回 200 | `server.mjs` 第 472–474 行；实测 A10/V4 |
| L2 | `GET /api/profiles` 带写盘副作用（自动铺种），不符合 GET 语义 | `server.mjs` 第 366 行；实测铺种前后文件变化 |
| L3 | `parseJsonLoose` 在「JSON 之前的正文里先出现花括号」时解析失败 | `prompt-engine.mjs` 第 495–499 行；实测 U3 |
| L4 | `run.cmd` 里 `set NO_OPEN=1` 关掉了「启动后自动打开浏览器」——而这恰是双击快捷方式最需要的行为，两处 README 都写「会自动打开」 | `run.cmd` 第 7 行 |
| L5 | 文档与实物不符：README 说双击 `start.cmd`（实际只有 `run.cmd`）；说「左边第 06 块是模型接口」（实际是 03）；说「界面截图见 screenshots/」（该目录不存在） | `README.md` 第 11、125、267 行；`ls` 确认 |
| L6 | 死代码/死 UI：`renderSegmented()` 定义了从不调用；`app.js` 导入 `TARGETS` 却未用；`state.serverDefaults` 只写不读；`<button id="generate" hidden>` 永不显示，rail 里的「生成提示词」入口形同虚设 | `app.js` 第 72、19、1378、68 行；真实浏览器确认 `#generate` 始终 `hidden` |
| L7 | `boot()` 里 `setInterval(...8000)` 写了两遍，掉线时双倍轮询 | `app.js` 第 1416、1424 行 |
| L8 | 接口卡片不显示「是否已配置 Key」，有无密钥的接口在列表上长得一模一样 | 实测 G13；`renderProfiles()` 未使用 `hasKey` |
| L9 | `saveForm` 里两行语句被各写了两遍（复制粘贴残留） | `profiles.js` 第 240–243 行 |
| L10 | 数字输入无校验：temperature 填 `abc` → `Number()` 得 `NaN` → 序列化成 `null` → 服务端静默忽略，用户看不到任何错误 | `profiles.js` 第 222 行 |
| L11 | `uninstall.ps1` 的兜底删除用 `Start-Job`，父会话退出后子作业会被终止，「2 秒后继续删除」基本不会执行；且按端口 5178 杀 `node.exe`/`cmd.exe`，可能误杀占用该端口的无关程序 | `uninstall.ps1` 第 17–27、78–83 行 |
| L12 | 服务端无 CORS / Origin 校验；遗留的 `/api/relay`（不带 id）允许浏览器把明文 Key 放进 body 传过来（`payload.apiKey`），属于可删除的历史攻击面 | `server.mjs` 第 267–271、475–478 行 |
| L13 | 流式转发忽略 `res.write()` 的背压；仅有 300s 硬超时，没有上游空闲超时 | `server.mjs` 第 341–351 行 |

### 另有 1 处「文档承诺但已不存在」的功能
两份 README 的「迭代与停止规则」章节都写：*"并在自评页的「迭代记录」里逐轮列出得分与停止原因"*。但 v6 已把「自评」标签页删除，评分只剩工具栏徽标，而徽标的 `title` 里**没有**逐轮记录（只有最后一条 verdict + 停止原因 + 问题清单）。逐轮得分实际只存在于内存的 `state.rounds`，用户看不到。

---

## 四、优化建议

### 1. 安全与数据（优先做）
1. **Key 传输**：`protectKey`/`revealKey` 改用 stdin 传值；不再把明文放进 argv。探测失败时页面顶部必须有显著提示，不能只藏在小字里。
2. **配置健壮性**：`loadStore` 解析失败 → 备份 + 报错 + 拒绝写；`GET` 不做写操作；`saveStore` 保留上一版。
3. **攻击面收敛**：删掉 `/api/relay`（无 id 版）与 `payload.apiKey` 分支；给 `/api/*` 加 `Origin`/`Host` 白名单校验，防止任意网页通过 `127.0.0.1` 调用本地服务（本地 CSRF / DNS rebinding）。
4. **错误分层**：参数/模板错误 → 400 中文；上游错误 → 透传状态码；未预期异常 → 500 但不回显内部堆栈与 JSON 解析位置（现在会回显 `at position 57`）。
5. **接口与协议解绑提醒**：改了 `baseUrl`/`protocol` 却沿用旧 Key 时，给一条提示（很可能把 DeepSeek 的 Key 发给了 OpenAI）。

### 2. 功能一致性
6. 按 B1 / B5 / B6 / B7 逐条修，并给「清空参数」一个显式入口。
7. **把迭代记录真正做出来**：在工具栏徽标的浮层（或恢复一个轻量面板）里逐轮列出「第几轮 / 得分 / 停止原因」，把 `state.rounds` 用起来，兑现 README 的承诺；回退时高亮被保留的那一轮。
8. **接口卡片补 Key 状态**：用 `hasKey` + `keyHint` 显示 `已配置 sk-…1234` / `未配置`，以及来源（`环境变量 DEEPSEEK_API_KEY`）。
9. **首启引导**：接口列表为空时，给一个「填入 DeepSeek / OpenAI Key」的一键入口，而不是只显示一句提示。

### 3. 工程与可维护性
10. **清死代码**：`renderSegmented`、未使用的 `TARGETS` 导入、`state.serverDefaults`、`#generate` 按钮、重复的 `setInterval`、重复的两行语句。
11. **配置加版本**：`profiles.json` 已有 `version: 1` 但没有任何迁移/校验逻辑，建议补 schema 校验与迁移入口，也为「损坏自动恢复」留钩子。
12. **统一变量正则**：`renderTemplate` 与 `extractVariables` 共用一份（含中文变量名），避免 B8 这类静默不一致。
13. **数字参数校验**：temperature / max tokens 在前后端都做范围校验（如 temperature ∈ [0,2]），非法值直接提示，不要静默变 `null`。
14. **把这个回归脚本纳入仓库**：本次的 API 用例（95 项）已经能覆盖转发、错误处理、加密落盘、并发、穿越；放进 `tests/` 每次改动跑一遍，成本极低。
15. **文档对齐**：`start.cmd` → `run.cmd`、片段编号 06 → 03、删掉 `screenshots/` 引用；把「自动打开浏览器」与 `NO_OPEN=1` 的行为统一（要么去掉 `NO_OPEN=1`，要么改文档说明「需手动打开地址」）。

---

## 五、附：测试产物

沙箱目录 `_pstest/`（原程序副本 + 测试脚本，可随时删除）：

| 文件 | 用途 |
| --- | --- |
| `mock-upstream.mjs` | 模拟上游模型服务：按系统提示词判定阶段返回分析/评审/撰写/修订内容，支持错误注入、流式、断连 |
| `test-api.mjs` | API 集成测试（53 项） |
| `test-extra.mjs` | 边界/并发/稳定性 + 共享模块单元测试（35 项） |
| `test-verify.mjs` | 复核自定义模板、响应头、中文名回归（7 项） |
| `test-front.mjs` | 注入最小 DOM 驱动真实前端模块（42 项） |
| `browser-test.js` / `cmp.js` / `filetest.js` | 真实浏览器端到端脚本 |

> 说明：`file://` 直接打开的模式未能在沙箱里用浏览器验证（Chromium 访问本地文件时 CDP 通道中断），该项仅按代码路径分析——`DIRECT` 下会跳过接口加载、直接进入离线规则模式，逻辑上自洽。
