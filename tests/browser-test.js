(async () => {
  const R = [];
  const rec = (id, name, pass, detail) => R.push({ id, name, pass: !!pass, d: detail === undefined ? "" : String(detail).slice(0, 220) });
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const API = location.origin;
  const errs = [];
  window.addEventListener("error", (e) => errs.push("error: " + e.message));
  window.addEventListener("unhandledrejection", (e) => errs.push("rejection: " + String((e.reason && e.reason.message) || e.reason)));
  window.confirm = () => true;
  const fire = (el) => el.dispatchEvent(new Event("input", { bubbles: true }));

  /* ---- 离线规则模式（当前没有任何接口）---- */
  const p0 = (await (await fetch(API + "/api/profiles")).json()).profiles.length;
  rec("G0", "起始时页面上没有接口", p0 === 0, "接口数=" + p0);
  $("#raw").value = "帮我给新品发布会写一封邀请函，发给三年以上的老客户";
  fire($("#raw"));
  $("#skipChat").click();
  await sleep(3200);
  const offline = $("#promptOut").value;
  rec("G1", "无接口时生成结构骨架（离线规则模式）", offline.length > 200 && offline.includes("# 目标"), offline.length + " 字");
  rec("G2", "生成后「导出为文档」按钮启用", $("#exportPrompt").disabled === false, "disabled=" + $("#exportPrompt").disabled);
  rec("G3", "离线模式评审/修订阶段标记为跳过", $('.stage[data-stage="critique"]').dataset.state === "skipped", $('.stage[data-stage="critique"]').dataset.state);
  rec("G4", "左栏那个「生成提示词」主按钮始终隐藏（无入口）", $("#generate").hidden === true, "hidden=" + $("#generate").hidden);

  /* ---- 导出为文档（拦截另存为对话框，检查落盘内容）---- */
  let exported = null;
  window.showSaveFilePicker = async () => ({ name: "prompt.md", createWritable: async () => ({ write: async (t) => { exported = t; }, close: async () => {} }) });
  $("#exportPrompt").click();
  await sleep(500);
  rec("G5", "导出文档包含需求/提示词/变量结构", !!exported && exported.includes("## 需求") && exported.includes("## 提示词"), exported ? exported.slice(0, 100) : "未捕获");
  rec("G6", "导出文档记录生成模型名", !!exported && /规则模式|生成模型/.test(exported), exported ? exported.match(/生成模型：.*/)?.[0] : "");

  /* ---- 复制提示词 ---- */
  $("#copyPrompt").click();
  await sleep(400);
  rec("G7", "复制按钮给出反馈（成功或提示手动复制）", /复制|全选|剪贴板/.test($("#log").textContent), $("#log").textContent);

  /* ---- 变量页 ---- */
  rec("G8", "变量页列出 {{request}}/{{extra}}", $("#varsOut").innerHTML.includes("request") && $("#varsOut").innerHTML.includes("extra"), $("#varsOut").innerHTML.slice(0, 120));
  const inputs = $("#varsOut").querySelectorAll("input[data-var-input]");
  if (inputs.length) { inputs[0].value = "活动名称占位"; fire(inputs[0]); }
  await sleep(100);
  rec("G9", "填写变量后「最终提示词」去掉占位符", $("#varFinal").textContent.includes("活动名称占位") && !$("#varFinal").textContent.includes("{{request}}"), $("#varFinal").textContent.slice(0, 80));

  /* ---- 表单新增接口 ---- */
  $("#addProfile").click();
  await sleep(80);
  $("#pfName").value = "浏览器建的接口";
  $("#pfBaseUrl").value = "http://127.0.0.1:5199/v1";
  $("#pfModelId").value = "mock";
  $("#pfApiKey").value = "sk-browser-test-123456";
  $("#pfSave").click();
  await sleep(800);
  const after = (await (await fetch(API + "/api/profiles")).json()).profiles;
  rec("G10", "通过表单新建接口成功", after.length === 1 && after[0].name === "浏览器建的接口", JSON.stringify(after.map((p) => p.name)));
  rec("G11", "新建后表单自动关闭", $("#profileForm").hidden === true, "hidden=" + $("#profileForm").hidden);
  rec("G12", "页面 HTML 里不出现明文密钥", !document.documentElement.outerHTML.includes("sk-browser-test-123456"), "");
  rec("G13", "列表显示密钥掩码", $("#profileList").innerHTML.includes("…"), $("#profileList").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 140));
  rec("G14", "接口卡片出现「环境变量」以外的测试状态位", $("#profileList").innerHTML.includes("pf-test"), "");

  /* ---- 接口测试按钮 ---- */
  const testBtn = document.querySelector('.pf-item button[data-act="test"]');
  if (testBtn) { testBtn.click(); await sleep(1500); }
  rec("G15", "点「测试」后给出连接结果", /连接成功|连接失败|测试失败/.test($("#log").textContent), $("#log").textContent);

  /* ---- 单模型 + 深度模式 ---- */
  $("#deep").checked = true;
  $("#deep").dispatchEvent(new Event("change", { bubbles: true }));
  $("#raw").value = "写一封活动邀请函";
  fire($("#raw"));
  $("#skipChat").click();
  await sleep(7000);
  const t = $("#promptOut").value;
  rec("G16", "接入接口后跑通完整流水线", t.includes("【撰写版】"), t.slice(0, 60));
  rec("G17", "深度模式：自评徽标出现在工具栏", $("#scoreChip").hidden === false && /自评/.test($("#scoreChip").textContent), $("#scoreChip").textContent);
  rec("G18", "深度模式：解析页渲染出结构化结果", $("#analysisOut").innerHTML.includes("品牌活动"), $("#analysisOut").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 120));
  rec("G19", "保留最高分版本：回退到撰写版而非修订版", t.includes("【撰写版】") && !t.includes("【修订版】"), t.slice(0, 40));
  rec("G20", "回退提示被下一条日志覆盖（用户看不到）", !/已回退到第/.test($("#log").textContent), $("#log").textContent);

  /* ---- 多模型对比 ---- */
  await (await fetch(API + "/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "对比B", baseUrl: "http://127.0.0.1:5199/v1", modelId: "mock", protocol: "openai" }) })).json();
  for (const b of document.querySelectorAll("#runMode button")) if (b.dataset.mode === "compare") b.click();
  await sleep(100);
  rec("G21", "切到多模型模式后徽标显示对比数", /对比\s*\d 个模型/.test($("#modeChip").textContent), $("#modeChip").textContent);
  $("#raw").value = "对比一次";
  fire($("#raw"));
  $("#skipChat").click();
  await sleep(6000);
  rec("G22", "多模型：生成两个模型选项卡", $("#modelTabs").querySelectorAll(".model-tab").length >= 2, $("#modelTabs").innerHTML.replace(/<[^>]+>/g, "|").slice(0, 200));
  rec("G23", "多模型：编辑器隐藏、对比正文可见", $("#editorShell").hidden === true && $("#modelBody").hidden === false, JSON.stringify({ s: $("#editorShell").hidden, b: $("#modelBody").hidden }));
  const useBtn = $("#modelUse");
  rec("G24", "「用这版」可用", useBtn.disabled === false, "disabled=" + useBtn.disabled);

  /* ---- 回到单模型 + 沟通流程 ---- */
  for (const b of document.querySelectorAll("#runMode button")) if (b.dataset.mode === "single") b.click();
  await sleep(150);
  $("#deep").checked = false;
  $("#deep").dispatchEvent(new Event("change", { bubbles: true }));
  $("#raw").value = "给小红书写一篇护肤品种草笔记";
  fire($("#raw"));
  $("#startChat").click();
  await sleep(1800);
  rec("G25", "沟通：AI 提出问题", /在哪个平台用/.test($("#chatLog").innerHTML), $("#chatLog").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 140));
  rec("G26", "沟通：信息快照可见", $("#chatFacts").hidden === false && /使用场景/.test($("#chatFacts").innerHTML), $("#chatFacts").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 120));
  rec("G27", "沟通：候选答案可点击填入", $("#chatLog").querySelectorAll("button[data-answer]").length > 0, $("#chatLog").querySelectorAll("button[data-answer]").length + " 个候选");
  rec("G28", "沟通阶段不产提示词", $("#promptOut").value === "", $("#promptOut").value.slice(0, 30));
  const chip = $("#chatLog").querySelector("button[data-answer]");
  if (chip) { chip.click(); await sleep(80); }
  rec("G29", "点候选答案会填进回答框", $("#chatAnswer").value.length > 0, $("#chatAnswer").value);
  $("#chatSend").click();
  await sleep(1800);
  rec("G30", "回答后进入第 2 轮", /第 2 轮/.test($("#chatRound").textContent), $("#chatRound").textContent);
  $("#chatGenerate").click();
  await sleep(4000);
  rec("G31", "点生成后才产出内容", $("#promptOut").value.length > 0, $("#promptOut").value.slice(0, 40));

  /* ---- 历史会话 ---- */
  rec("G32", "历史会话面板记录了会话", $("#historyCount").textContent !== "0", $("#historyCount").textContent + " / " + $("#sessionList").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 100));

  /* ---- 元提示词模板 ---- */
  $("#metaAsk").value = "自定义提问模板";
  $("#metaSave").click();
  await sleep(100);
  rec("G33", "保存元提示词模板后状态变为已自定义", $("#metaState").textContent === "已自定义", $("#metaState").textContent);
  $("#metaReset").click();
  await sleep(100);
  rec("G34", "恢复默认元提示词生效", $("#metaState").textContent === "默认", $("#metaState").textContent);

  /* ---- 全屏 ---- */
  $("#expandEditor").click();
  await sleep(50);
  rec("G35", "全屏按钮切换编辑器全屏", $("#editorShell").classList.contains("is-fullscreen"), $("#expandEditor").textContent);
  $("#expandEditor").click();
  await sleep(50);
  rec("G36", "再次点击退出全屏", !$("#editorShell").classList.contains("is-fullscreen"), $("#expandEditor").textContent);

  await sleep(300);
  return { results: R, errors: errs, failed: R.filter((x) => !x.pass).map((x) => x.id + " " + x.name) };
})()
