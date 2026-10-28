#!/usr/bin/env node
// 闲鱼监控 CLI（不依赖 DSH 插件加载机制，直接调本地后端）
// 用法:
//   node xianyu.mjs service                         查后端/账号/任务状态
//   node xianyu.mjs results [文件名] [--all]         查已有结果（默认只看推荐）
//   node xianyu.mjs search "关键词" [--req "需求"] [--max-price 7000] [--pages 2] [--no-wait]
import { makeClient, normalizeItem, waitTaskDone } from "./lib.mjs";

const BASE = process.env.XIANYU_BASE || "http://127.0.0.1:8000";
const ACCOUNT = process.env.XIANYU_ACCOUNT || "acc_main";
const client = makeClient(BASE);

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function has(flag) { return process.argv.includes(flag); }

function fmtList(items, meta) {
  if (!items.length) { console.log(`（无结果）${meta || ""}`); return; }
  if (meta) console.log(meta);
  items.forEach((it, i) => {
    const flag = it.recommended ? "✅" : "❌";
    const med = it.marketMedian != null ? `（市内中位¥${it.marketMedian}）` : "";
    console.log(`\n${i + 1}. ${flag} ${it.price}${med} | ${it.seller} | ${it.region}`);
    console.log(`   ${it.title}`);
    if (it.reason) console.log(`   AI：${it.reason}`);
    if (it.riskTags?.length) console.log(`   风险：${it.riskTags.join("；")}`);
    if (it.link) console.log(`   链接：${it.link.split("&")[0]}`);
  });
}

const cmd = process.argv[2];

if (cmd === "service") {
  if (!(await client.health())) { console.log(`❌ 后端未运行（${BASE}）。启动：cd ~/ai-goofish-run && ./start.sh`); process.exit(1); }
  const acc = await client.accounts();
  const ts = await client.tasks();
  console.log(`✅ 后端运行中：${BASE}`);
  console.log(`账号：${acc.map(a => a.name).join(", ") || "无"}`);
  console.log(`任务：\n${ts.map(t => `  #${t.id} ${t.task_name} [${t.is_running ? "运行中" : "空闲"}]`).join("\n") || "  无"}`);
} else if (cmd === "results") {
  if (!(await client.health())) { console.log(`❌ 后端未运行（${BASE}）`); process.exit(1); }
  const filename = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  if (!filename) {
    const files = await client.resultFiles();
    console.log(files.length ? `可用结果文件：\n${files.map(f => "  " + f).join("\n")}\n\n用法: node xianyu.mjs results <文件名> [--all]` : "无结果文件（还没跑过搜索）");
  } else {
    const res = await client.results(filename, { limit: 100, recommendedOnly: !has("--all") });
    fmtList((res.items || []).map(normalizeItem), `📄 ${filename}（共${res.total_items ?? 0}条，显示${(res.items || []).length}条）：`);
  }
} else if (cmd === "search") {
  const keyword = process.argv[3];
  if (!keyword || keyword.startsWith("--")) { console.log('用法: node xianyu.mjs search "关键词" [--req "需求"] [--max-price 7000] [--pages 2] [--no-wait]'); process.exit(1); }
  if (!(await client.health())) { console.log(`❌ 后端未运行（${BASE}）`); process.exit(1); }
  const req = arg("--req", "");
  const maxPrice = arg("--max-price", "");
  const minPrice = arg("--min-price", "");
  const pages = Number(arg("--pages", "2"));
  const useAI = req.trim().length > 0;
  const payload = {
    task_name: `cli-${keyword}-${Date.now().toString(36)}`,
    keyword, description: req, decision_mode: useAI ? "ai" : "keyword",
    min_price: minPrice, max_price: maxPrice, max_pages: pages,
    account_state_file: `state/${ACCOUNT}.json`, account_strategy: "fixed",
  };
  if (!useAI) payload.keyword_rules = [keyword];
  console.log(`提交任务：${keyword}${req ? "（AI 判定需求已设置）" : ""}...`);
  const created = await client.createTask(payload);
  let taskId;
  if (created?.task?.id != null) taskId = created.task.id;
  else if (created?.job?.job_id) {
    const jobId = created.job.job_id;
    console.log("AI 生成判定标准中...");
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const job = await client.genJob(jobId);
      if (job?.status === "completed") { const t = await client.tasks(); taskId = t.find(x => x.task_name === payload.task_name)?.id; break; }
      if (job?.status === "failed") { console.log("❌ AI 标准生成失败:", job.message); process.exit(1); }
    }
  }
  if (taskId == null) { console.log("❌ 未定位任务 id"); process.exit(1); }
  await client.startTask(taskId);
  console.log(`▶️ 任务 #${taskId} 已启动，爬取+AI 判定中（通常5-15分钟）...`);
  if (has("--no-wait")) { console.log(`后台运行。稍后: node xianyu.mjs results`); process.exit(0); }
  const { done } = await waitTaskDone(client, taskId, { timeoutMs: 20 * 60 * 1000 });
  if (!done) { console.log(`⏳ 超时仍在跑，稍后查 results`); process.exit(0); }
  const files = await client.resultFiles();
  const slug = keyword.replace(/\s+/g, "_");
  const filename = files.find(f => f.startsWith(slug)) || files[files.length - 1];
  const res = await client.results(filename, { limit: 200 });
  const items = (res.items || []).map(normalizeItem);
  const rec = items.filter(x => x.recommended);
  fmtList(rec.length ? rec : items, `💰「${keyword}」结果（共${items.length}件，AI推荐${rec.length}件）：`);
} else {
  console.log(`用法：
  node xianyu.mjs service
  node xianyu.mjs results [文件名] [--all]
  node xianyu.mjs search "关键词" --req "需求" --max-price 7000 --pages 2`);
}
