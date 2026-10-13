(async () => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errs = [];
  window.addEventListener("error", (e) => errs.push(e.message));
  const out = { proto: location.protocol, ready: document.documentElement.dataset.appReady, chip: $("#modeChip").textContent, note: $("#apiNote").textContent.slice(0, 60), profileList: $("#profileList").textContent.slice(0, 80) };
  $("#raw").value = "帮我写一个读取 csv 的 python 脚本";
  $("#raw").dispatchEvent(new Event("input", { bubbles: true }));
  $("#skipChat").click();
  await sleep(3200);
  out.promptLen = $("#promptOut").value.length;
  out.hasSkeleton = $("#promptOut").value.includes("# 目标");
  out.stageCritique = $('.stage[data-stage="critique"]').dataset.state;
  out.log = $("#log").textContent.slice(0, 120);
  out.errs = errs;
  return out;
})()
