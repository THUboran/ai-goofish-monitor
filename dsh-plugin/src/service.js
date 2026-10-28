// 闲鱼监控服务客户端：封装对本地 ai-goofish-monitor 后端 (localhost:8000) 的调用
// 纯 fetch，无第三方依赖，Node 18+ 内置。

const DEFAULT_BASE = "http://127.0.0.1:8000";

export function makeClient(baseURL = DEFAULT_BASE) {
  const base = baseURL.replace(/\/+$/, "");

  async function req(path, init = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(base + path, { ...init, signal: ctrl.signal });
      const text = await r.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { ok: r.ok, status: r.status, body };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    base,
    // 健康检查
    async health() {
      try {
        const r = await req("/", { method: "GET" }, 3000);
        return r.status >= 200 && r.status < 500;
      } catch { return false; }
    },
    // 账号列表
    async accounts() {
      const r = await req("/api/accounts", { method: "GET" });
      return r.body || [];
    },
    // 任务列表
    async tasks() {
      const r = await req("/api/tasks", { method: "GET" });
      const b = r.body;
      return Array.isArray(b) ? b : (b && b.tasks) || [];
    },
    // 创建任务（AI 模式或关键词模式）
    async createTask(payload) {
      const r = await req("/api/tasks/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 20000);
      if (!r.ok) throw new Error(`创建任务失败 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      return r.body;
    },
    async genJob(jobId) {
      const r = await req(`/api/tasks/generate-jobs/${jobId}`, { method: "GET" });
      return r.body && (r.body.job || r.body);
    },
    async startTask(id) {
      const r = await req(`/api/tasks/start/${id}`, { method: "POST" }, 15000);
      return r.body;
    },
    async stopTask(id) {
      const r = await req(`/api/tasks/stop/${id}`, { method: "POST" }, 15000);
      return r.body;
    },
    async task(id) {
      const r = await req(`/api/tasks/${id}`, { method: "GET" });
      return r.body;
    },
    async deleteTask(id) {
      const r = await req(`/api/tasks/${id}`, { method: "DELETE" });
      return r.body;
    },
    // 结果文件列表
    async resultFiles() {
      const r = await req("/api/results/files", { method: "GET" });
      return (r.body && r.body.files) || [];
    },
    // 查某结果文件里的条目
    async results(filename, { page = 1, limit = 50, recommendedOnly = false } = {}) {
      const q = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (recommendedOnly) q.set("ai_recommended_only", "true");
      const r = await req(`/api/results/${encodeURIComponent(filename)}?${q.toString()}`, { method: "GET" });
      return r.body || { items: [], total_items: 0 };
    },
  };
}

// 把任务名转成后端生成的结果文件名（后端用 keyword 下划线化，实际以 /api/results/files 为准）
// 这里不猜文件名，靠 files 列表 + 任务名匹配来定位。

// 从一条原始结果条目里抽出对用户最有用的字段
export function normalizeItem(it) {
  const g = it["商品信息"] || {};
  const ai = it.ai_analysis || {};
  const seller = it["卖家信息"] || {};
  const priceRef = it["价格参考"] || {};
  const cur = (priceRef["当前搜索样本"] || {});
  return {
    title: g["商品标题"] || "",
    price: g["当前售价"] || "",
    link: g["商品链接"] || "",
    region: g["发货地区"] || "",
    seller: g["卖家昵称"] || seller["卖家昵称"] || "",
    sellerCredit: seller["卖家信用等级"] || "",
    sellerAge: seller["卖家注册时长"] || "",
    wants: g["“想要”人数"] ?? null,
    recommended: ai.is_recommended === true,
    reason: ai.reason || "",
    riskTags: Array.isArray(ai.risk_tags) ? ai.risk_tags : [],
    marketMedian: cur.median_price ?? null,
    publishTime: g["发布时间"] || "",
  };
}

// 等任务从 running=true 变成 false（跑完），或超时
export async function waitTaskDone(client, taskId, { intervalMs = 5000, timeoutMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await client.task(taskId);
    if (!t) return { done: true, task: null };
    if (t.is_running === false) return { done: true, task: t };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { done: false, task: await client.task(taskId) };
}
