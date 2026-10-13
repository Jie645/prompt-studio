(async () => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const API = location.origin;
  const fire = (el) => el.dispatchEvent(new Event("input", { bubbles: true }));
  const j = (await (await fetch(API + "/api/profiles")).json()).profiles;
  const out = { profiles: j.map((p) => p.name), tabs: 0, shellHidden: null, bodyHidden: null, chip: "", perTab: [], log: "" };
  for (const b of document.querySelectorAll("#runMode button")) if (b.dataset.mode === "compare") b.click();
  await sleep(150);
  out.chip = $("#modeChip").textContent;
  $("#raw").value = "对比一次";
  fire($("#raw"));
  $("#skipChat").click();
  await sleep(6000);
  out.tabs = $("#modelTabs").querySelectorAll(".model-tab").length;
  out.perTab = [...$("#modelTabs").querySelectorAll(".model-tab")].map((t) => t.textContent.trim());
  out.shellHidden = $("#editorShell").hidden;
  out.bodyHidden = $("#modelBody").hidden;
  out.body = $("#modelBody").textContent.slice(0, 60);
  out.log = $("#log").textContent;
  // 点第二个标签
  const tabs = $("#modelTabs").querySelectorAll(".model-tab");
  if (tabs.length > 1) { tabs[1].click(); await sleep(150); out.afterSwitch = $("#modelBody").textContent.slice(0, 40); }
  out.failedOnes = (() => { try { return $("#modelTabs").innerText; } catch (e) { return ""; } })();
  return out;
})()
