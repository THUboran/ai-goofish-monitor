// 闲鱼监控 DSH 插件入口
// 注册 xianyu_search / xianyu_results / xianyu_service 三个工具，
// 全部通过本地 ai-goofish-monitor 后端 (localhost:8000) 工作。
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { makeClient, normalizeItem, waitTaskDone } from "./service.js";

export const name = "dsh-xianyu-monitor";
export const inject = ["tools"];

export const Config = z.object({
  baseURL: z.string().default("http://127.0.0.1:8000")
    .description("ai-goofish-monitor 后端地址，默认 http://127.0.0.1:8000"),
  defaultAccount: z.string().default("acc_main")
    .description("默认闲鱼登录态账号名（state/ 下的 json 文件名，不含 .json）"),
  maxWaitMinutes: z.number().step(1).min(1).default(15)
    .description("单次搜索等待爬虫跑完的最长分钟数"),
});

function fmtMoney(v) {
  if (v === null || v === undefined || v === "") return "?";
  return String(v);
}

// 把一批归一化商品渲染成给模型/用户看的紧凑文本
function renderList(items, meta = "") {
  if (!items.length) {
    return `没有符合条件的商品。${meta}`.trim();
  }
  const lines = [];
  if (meta) lines.push(meta);
  lines.push(`共 ${items.length} 条：`);
  lines.push("");
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const flag = it.recommended ? "✅" : "❌";
    const price = fmtMoney(it.price);
    const med = it.marketMedian != null ? `（市场中位 ¥${it.marketMedian}）` : "";
    lines.push(`${i + 1}. ${flag} ${price}${med} | ${it.seller || "?"} | ${it.region || ""}`);
    lines.push(`   ${it.title}`);
    if (it.reason) lines.push(`   AI：${it.reason}`);
    if (it.riskTags && it.riskTags.length) lines.push(`   风险：${it.riskTags.join("；")}`);
    if (it.link) lines.push(`   链接：${it.link.split("&")[0]}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function apply(ctx, config) {
  const cfg = config || {};
  const client = makeClient(cfg.baseURL || "http://127.0.0.1:8000");
  const defaultAccount = cfg.defaultAccount || "acc_main";
  const maxWaitMs = (cfg.maxWaitMinutes || 15) * 60 * 1000;

  // ── 工具 1：跑一次闲鱼搜索 + AI 判定 ──
  ctx.tools.register(defineTool({
    name: "xianyu_search",
    description:
      "在闲鱼上按关键词搜索二手商品，用 AI 多模态模型（看图+画像分析）判定哪些是高性价比捡漏。会真实启动爬虫抓取（耗时数分钟）。返回推荐/不推荐清单、价格、卖家、AI 理由和链接。",
    parameters: {
      keyword: {
        type: "string", required: true,
        description: "搜索关键词，如 'MacBook Air M5'",
      },
      requirement: {
        type: "string",
        description: "用自然语言写你想要的商品条件（型号配置、价格上限、成色、是否个人卖家等），AI 据此生成判定标准。不填则按关键词+价格过滤。",
      },
      max_price: { type: "string", description: "价格上限（元）" },
      min_price: { type: "string", description: "价格下限（元）" },
      max_pages: { type: "number", description: "抓取页数，默认 2（每页约 30 件）" },
      account: { type: "string", description: `闲鱼登录态账号名，默认 ${defaultAccount}` },
      wait: {
        type: "boolean",
        description: "是否等待爬虫跑完再返回结果，默认 true。false 则立刻返回、后台继续跑（之后用 xianyu_results 查）",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          finished: { type: "boolean", required: true },
          taskId: { type: "integer" },
          filename: { type: "string" },
          summary: { type: "string", required: true },
          total: { type: "integer" },
          recommendedCount: { type: "integer" },
          message: { type: "string" },
        },
      },
      render(args, value) { return [{ type: "text", text: String(value.summary ?? "") }]; },
    },
    async execute(args) {
      const alive = await client.health();
      if (!alive) {
        return {
          ok: false, finished: false, summary:
            `❌ 闲鱼监控后端没在跑（${client.base}）。请先启动：\n  cd ~/ai-goofish-run && PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers .venv/bin/python -u -m src.app\n（或运行 ~/ai-goofish-run/start.sh）`,
        };
      }
      const account = args.account || defaultAccount;
      const useAI = !!(args.requirement && args.requirement.trim());
      const payload = {
        task_name: `dsh-${args.keyword}-${Date.now().toString(36)}`,
        keyword: args.keyword,
        description: args.requirement || "",
        decision_mode: useAI ? "ai" : "keyword",
        min_price: args.min_price || "",
        max_price: args.max_price || "",
        max_pages: args.max_pages || 2,
        account_state_file: `state/${account}.json`,
        account_strategy: "fixed",
      };
      if (!useAI) payload.keyword_rules = [args.keyword];

      let created;
      try {
        created = await client.createTask(payload);
      } catch (e) {
        return { ok: false, finished: false, summary: `❌ 创建任务失败：${e.message}` };
      }

      // 定位新建任务的 id
      let taskId;
      if (created && created.task && typeof created.task.id === "number") {
        taskId = created.task.id;
      } else if (created && created.job && created.job.job_id) {
        // AI 模式：等标准生成完成
        const jobId = created.job.job_id;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const job = await client.genJob(jobId);
          const st = job && job.status;
          if (st === "completed") {
            const t = await client.tasks();
            const match = t.find((x) => x.task_name === payload.task_name);
            if (match) taskId = match.id;
            break;
          }
          if (st === "failed") {
            return { ok: false, finished: false, summary: `❌ AI 判定标准生成失败：${(job && job.message) || "unknown"}` };
          }
        }
      }
      if (taskId === undefined) {
        return { ok: false, finished: false, summary: "❌ 任务已提交但未能定位任务 id，请到 Web UI 查看。" };
      }

      try { await client.startTask(taskId); }
      catch (e) { return { ok: false, finished: false, taskId, summary: `❌ 启动爬虫失败：${e.message}` }; }

      if (args.wait === false) {
        return {
          ok: true, finished: false, taskId,
          summary: `▶️ 已在后台启动任务 #${taskId}（关键词：${args.keyword}）。抓取+AI 判定通常需 5–15 分钟，跑完用 xianyu_results 查询结果。`,
        };
      }

      const { done } = await waitTaskDone(client, taskId, { timeoutMs: maxWaitMs });
      if (!done) {
        return {
          ok: true, finished: false, taskId,
          summary: `⏳ 任务 #${taskId} 仍在跑（超过 ${cfg.maxWaitMinutes || 15} 分钟）。稍后用 xianyu_results 查询。`,
        };
      }

      // 跑完了，取结果
      const files = await client.resultFiles();
      // 结果文件名由后端按 keyword 生成，取最新/匹配的
      const kwSlug = args.keyword.replace(/\s+/g, "_");
      let filename = files.find((f) => f.startsWith(kwSlug)) || files[files.length - 1];
      if (!filename) {
        return { ok: true, finished: true, taskId, summary: `✅ 任务 #${taskId} 跑完，但没找到结果文件，可能一件都没匹配到。` };
      }
      const res = await client.results(filename, { limit: 200 });
      const items = (res.items || []).map(normalizeItem);
      const rec = items.filter((x) => x.recommended);
      const summary = renderList(
        rec.length ? rec : items,
        `💰 闲鱼「${args.keyword}」搜索结果（${filename}，共 ${items.length} 件，AI 推荐 ${rec.length} 件）：`
      );
      return {
        ok: true, finished: true, taskId, filename,
        total: items.length, recommendedCount: rec.length,
        summary,
      };
    },
    presentCall: (args) => `闲鱼搜索：${args.keyword}`,
  }));

  // ── 工具 2：查已有结果（不重新爬） ──
  ctx.tools.register(defineTool({
    name: "xianyu_results",
    description:
      "查询闲鱼监控已抓取的结果（不重新爬）。可列出所有结果文件，或按文件名+仅看推荐筛选，返回商品清单与 AI 判定。",
    parameters: {
      filename: { type: "string", description: "结果文件名，如 MacBook_Air_M5_full_data.jsonl；不填则列出所有可用结果文件" },
      recommended_only: { type: "boolean", description: "是否只看 AI 推荐的，默认 true" },
      limit: { type: "number", description: "最多返回条数，默认 30" },
      account: { type: "string", description: "保留参数，当前不需要" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          summary: { type: "string", required: true },
        },
      },
      render(args, value) { return [{ type: "text", text: String(value.summary ?? "") }]; },
    },
    async execute(args) {
      const alive = await client.health();
      if (!alive) {
        return { ok: false, summary: `❌ 闲鱼监控后端没在跑（${client.base}）。请先启动 ~/ai-goofish-run 里的服务。` };
      }
      const files = await client.resultFiles();
      if (!args.filename) {
        return {
          ok: true,
          summary: files.length
            ? `可用结果文件：\n${files.map((f) => `- ${f}`).join("\n")}\n\n用 xianyu_results(filename=...) 查看某个文件的具体商品。`
            : "目前没有任何结果文件（还没跑过搜索）。",
        };
      }
      const res = await client.results(args.filename, {
        limit: args.limit || 30,
        recommendedOnly: args.recommended_only !== false,
      });
      const items = (res.items || []).map(normalizeItem);
      return {
        ok: true,
        summary: renderList(items, `📄 ${args.filename}（总 ${res.total_items ?? items.length} 条，显示 ${items.length} 条）：`),
      };
    },
    presentCall: (args) => `查闲鱼结果${args.filename ? "：" + args.filename : ""}`,
  }));

  // ── 工具 3：服务/账号状态自检 ──
  ctx.tools.register(defineTool({
    name: "xianyu_service",
    description: "检查闲鱼监控后端是否在运行、有哪些账号、有哪些任务。用于排查『为什么搜不了』。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          summary: { type: "string", required: true },
        },
      },
      render(args, value) { return [{ type: "text", text: String(value.summary ?? "") }]; },
    },
    async execute() {
      const alive = await client.health();
      if (!alive) {
        return {
          ok: false,
          summary: `❌ 后端未运行（${client.base}）。\n启动方法：\n  cd ~/ai-goofish-run && ./start.sh\n或\n  cd ~/ai-goofish-run && PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers .venv/bin/python -u -m src.app`,
        };
      }
      const accounts = await client.accounts();
      const tasks = await client.tasks();
      const accList = accounts.map((a) => a.name).join(", ") || "（无）";
      const taskList = tasks.map((t) => `#${t.id} ${t.task_name} [${t.is_running ? "运行中" : "空闲"}]`).join("\n  ") || "（无）";
      return {
        ok: true,
        summary: `✅ 后端运行中：${client.base}\n账号：${accList}\n任务：\n  ${taskList}`,
      };
    },
    presentCall: () => "闲鱼服务状态",
  }));
}

export default { name, inject, Config, apply };
