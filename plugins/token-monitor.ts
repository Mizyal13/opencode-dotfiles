import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OPENCODE_MONITOR_PORT || 8590);
const DB_PATH =
  process.env.OPENCODE_MONITOR_DB ||
  join(homedir(), ".local/share/opencode/opencode.db");
const CONFIG_PATH =
  process.env.OPENCODE_MONITOR_CONFIG ||
  join(homedir(), ".config/opencode/opencode.jsonc");

const FAST_TTL = 5000;
const SLOW_TTL = 60_000;

const MODEL_LIMITS: Record<string, { context: string; rate: string }> = {
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free": {
    context: "1M",
    rate: "OpenRouter :free · 20 req/mnt",
  },
  "openrouter/nvidia/nemotron-3.5-lightning:free": {
    context: "1M",
    rate: "OpenRouter :free · 20 req/mnt",
  },
  "opencode/big-pickle": { context: "?", rate: "opencode-provider" },
};

type Config = {
  model?: string;
  small_model?: string;
  share?: string;
  compaction?: { auto?: boolean; tail_turns?: number };
  tool_output?: { max_lines?: number; max_bytes?: number };
  agent?: Record<string, { model?: string }>;
};

let cfgCache: { at: number; cfg: Config } | null = null;

function parseJsonc(text: string): any {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(s);
}

function readConfig(): Config {
  if (cfgCache && Date.now() - cfgCache.at < SLOW_TTL) return cfgCache.cfg;
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const cfg = (parseJsonc(text) ?? {}) as Config;
    cfgCache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    cfgCache = { at: Date.now(), cfg: {} };
    return {};
  }
}

let server: ReturnType<typeof import("bun").serve> | null = null;
let db: Database | null = null;
let fastCache: { at: number; data: any } | null = null;
let slowCache: { at: number; data: any } | null = null;
let startedAt = Date.now();

function fmtPort(p: number) {
  return `http://${HOST}:${p}`;
}

function startServer() {
  const served = (s: ReturnType<typeof import("bun").serve>) => {
    console.log(
      `[token-monitor] dashboard: ${fmtPort(s.port)} (db: ${DB_PATH})`,
    );
  };
  let lastErr: unknown = null;
  for (let p = PORT; p < PORT + 20; p++) {
    try {
      const s = (globalThis as any).Bun.serve({
        hostname: HOST,
        port: p,
        idleTimeout: 0,
        fetch(req: Request) {
          const url = new URL(req.url);
          if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(PAGE, {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          if (url.pathname === "/api/health") {
            return json({ ok: true, port: p, uptime: Date.now() - startedAt });
          }
          if (url.pathname === "/api/stats") {
            return json(getStats(p));
          }
          return json({ ok: false, error: "not found" }, 404);
        },
      });
      served(s);
      return s;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(
    `[token-monitor] tidak bisa bind ${HOST}:${PORT}..${PORT + 19}: ${
      String(lastErr)
    }`,
  );
  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseModel(m: string): { provider: string; id: string; raw: string } {
  try {
    const o = JSON.parse(m);
    return {
      provider: o?.providerID ?? "?",
      id: o?.id ?? m,
      raw: m,
    };
  } catch {
    return { provider: "?", id: m, raw: m };
  }
}

function query<T>(sql: string, params: unknown[] = []): T[] {
  if (!db) return [];
  try {
    return (db.query(sql).all(...(params as any[])) as unknown as T[]) || [];
  } catch (e) {
    console.error(`[token-monitor] query error: ${sql} :: ${String(e)}`);
    return [];
  }
}

type OverRow = {
  sessions: number;
  cost: number;
  tin: number;
  tout: number;
  trsn: number;
  tcach_r: number;
  tcach_w: number;
};

function overview(from: number | null): OverRow {
  const where = from ? "WHERE time_updated >= ? AND time_updated <= ?" : "";
  const params = from ? [from, Date.now()] : [];
  const rows = query<OverRow>(
    `SELECT COUNT(*) AS sessions,
       COALESCE(SUM(cost),0)              AS cost,
       COALESCE(SUM(tokens_input),0)      AS tin,
       COALESCE(SUM(tokens_output),0)     AS tout,
       COALESCE(SUM(tokens_reasoning),0)  AS trsn,
       COALESCE(SUM(tokens_cache_read),0) AS tcach_r,
       COALESCE(SUM(tokens_cache_write),0) AS tcach_w
     FROM session ${where}`,
    params,
  );
  return rows[0] ?? {
    sessions: 0, cost: 0, tin: 0, tout: 0, trsn: 0, tcach_r: 0, tcach_w: 0,
  };
}

function startOfLocalDay(offsetDays = 0): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

function computeTrend() {
  const rows = query<{
    d: string; n: number; cost: number;
    tin: number; tout: number; tcach_r: number;
  }>(
    `SELECT date(time_updated/1000,'unixepoch','localtime') AS d,
       COUNT(*) AS n,
       COALESCE(SUM(cost),0)              AS cost,
       COALESCE(SUM(tokens_input),0)      AS tin,
       COALESCE(SUM(tokens_output),0)     AS tout,
       COALESCE(SUM(tokens_cache_read),0) AS tcach_r
     FROM session
     WHERE time_updated >= ?
     GROUP BY d ORDER BY d`,
    [Date.now() - 45 * 86400_000],
  );
  interface Day { date: string; sessions: number; cost: number; input: number; output: number; cacheRead: number }
  const days: Day[] = rows.map((r) => ({
    date: r.d,
    sessions: r.n,
    cost: r.cost,
    input: r.tin,
    output: r.tout,
    cacheRead: r.tcach_r,
  }));
  const filled: Day[] = [];
  const last30 = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(last30.getDate() - i);
    const key = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    const hit = days.find((x) => x.date === key);
    filled.push({ date: key, sessions: hit?.sessions ?? 0, cost: hit?.cost ?? 0, input: hit?.input ?? 0, output: hit?.output ?? 0, cacheRead: hit?.cacheRead ?? 0 });
  }
  return filled;
}

function computeModels() {
  const rows = query<{
    model: string; n: number; cost: number; tin: number; tout: number;
  }>(
    `SELECT model, COUNT(*) AS n,
       COALESCE(SUM(cost),0)          AS cost,
       COALESCE(SUM(tokens_input),0)  AS tin,
       COALESCE(SUM(tokens_output),0) AS tout
     FROM session GROUP BY model ORDER BY tin DESC`,
  );
  return rows.map((r) => {
    const m = parseModel(r.model);
    return {
      provider: m.provider,
      model: m.id,
      sessions: r.n,
      cost: r.cost,
      input: r.tin,
      output: r.tout,
    };
  });
}

function computeProjects() {
  const rows = query<{
    pid: string; name: string; dir: string; n: number; tin: number; cost: number;
  }>(
    `SELECT s.project_id AS pid,
       COALESCE(p.name, p.worktree) AS name,
       MAX(s.directory) AS dir,
       COUNT(*) AS n,
       COALESCE(SUM(s.tokens_input),0) AS tin,
       COALESCE(SUM(s.cost),0) AS cost
     FROM session s
     LEFT JOIN project p ON p.id = s.project_id
     GROUP BY s.project_id
     ORDER BY tin DESC`,
  );
  return rows.map((r) => ({
    id: r.pid,
    name: r.name || r.pid,
    directory: r.dir,
    sessions: r.n,
    input: r.tin,
    cost: r.cost,
  }));
}

function computeRecent() {
  const rows = query<{
    id: string; title: string; directory: string; model: string;
    cost: number; tin: number; tout: number; tcach_r: number; tcach_w: number;
    updated: number;
  }>(
    `SELECT id, title, directory, model, cost,
       tokens_input AS tin, tokens_output AS tout,
       tokens_cache_read AS tcach_r, tokens_cache_write AS tcach_w,
       time_updated AS updated
     FROM session ORDER BY time_updated DESC LIMIT 60`,
  );
  return rows.map((r) => {
    const m = parseModel(r.model);
    return {
      id: r.id,
      title: r.title,
      directory: r.directory,
      model: `${m.provider}/${m.id}`,
      cost: r.cost,
      input: r.tin,
      output: r.tout,
      cacheRead: r.tcach_r,
      cacheWrite: r.tcach_w,
      updated: r.updated,
    };
  });
}

function computeTools() {
  if (slowCache && Date.now() - slowCache.at < SLOW_TTL) return slowCache.data;
  const rows = query<{ data: string }>(
    `SELECT data FROM part WHERE time_created >= ? AND data LIKE '%"type":"tool"%'`,
    [Date.now() - 7 * 86400_000],
  );
  const count: Record<string, number> = {};
  for (const r of rows) {
    try {
      const o = JSON.parse(r.data);
      if (o?.type === "tool" && o.tool) count[o.tool] = (count[o.tool] ?? 0) + 1;
    } catch { /* skip */ }
  }
  const tools = Object.entries(count)
    .map(([tool, n]) => ({ tool, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);
  slowCache = { at: Date.now(), data: tools };
  return tools;
}

function getLive() {
  const rows = query<{
    id: string; title: string; directory: string; model: string;
    cost: number; tin: number; tout: number; trsn: number;
    tcach_r: number; tcach_w: number; updated: number;
  }>(
    `SELECT id, title, directory, model, cost,
       tokens_input AS tin, tokens_output AS tout, tokens_reasoning AS trsn,
       tokens_cache_read AS tcach_r, tokens_cache_write AS tcach_w,
       time_updated AS updated
     FROM session ORDER BY time_updated DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  const m = parseModel(r.model);
  return {
    id: r.id,
    title: r.title,
    directory: r.directory,
    model: `${m.provider}/${m.id}`,
    cost: r.cost,
    tokens: {
      input: r.tin,
      output: r.tout,
      reasoning: r.trsn,
      cacheRead: r.tcach_r,
      cacheWrite: r.tcach_w,
    },
    updated: r.updated,
  };
}

function computeLimits() {
  const cfg = readConfig();
  const usage = new Map<string, number>();
  const rows = query<{ model: string; tin: number }>(
    `SELECT model, COALESCE(SUM(tokens_input),0) AS tin
     FROM session GROUP BY model`,
  );
  for (const r of rows) usage.set(r.model, r.tin);

  type LimitRow = {
    spec: string;
    value: string;
  };
  const limits: LimitRow[] = [];

  const pushKey = (label: string, value: unknown, suffix = "") => {
    limits.push({
      spec: label,
      value: value === undefined || value === null
        ? "-"
        : typeof value === "boolean"
          ? value ? "aktif" : "mati"
          : String(value) + suffix,
    });
  };

  pushKey("model", cfg.model);
  pushKey("small_model", cfg.small_model);
  pushKey("agent.explore.model", cfg.agent?.explore?.model);
  pushKey("agent.reviewer.model", cfg.agent?.reviewer?.model);
  pushKey("compaction.auto", cfg.compaction?.auto);
  pushKey("compaction.tail_turns", cfg.compaction?.tail_turns, " turn");
  pushKey("tool_output.max_lines", cfg.tool_output?.max_lines, " baris");
  pushKey("tool_output.max_bytes", cfg.tool_output?.max_bytes, " byte");
  pushKey("share", cfg.share);

  const modelIds = new Set<string>();
  const add = (m?: string) => {
    if (m) {
      try {
        const o = JSON.parse(m);
        if (o?.id) modelIds.add(o.id);
        else modelIds.add(m);
        return;
      } catch {
        modelIds.add(m);
      }
    }
  };
  add(cfg.model);
  add(cfg.small_model);
  add(cfg.agent?.explore?.model);
  add(cfg.agent?.reviewer?.model);

  const modelRows: { id: string; context: string; rate: string; tin: number }[] = [];
  for (const id of modelIds) {
    const lim = MODEL_LIMITS[id] ?? { context: "?", rate: "-" };
    const tin = [...usage.entries()]
      .filter(([m]) => m.includes(id.slice(id.lastIndexOf("/") + 1)))
      .reduce((a, [, v]) => a + v, 0);
    modelRows.push({ id, context: lim.context, rate: lim.rate, tin });
  }
  modelRows.sort((a, b) => b.tin - a.tin);

  return {
    configPath: CONFIG_PATH,
    source: cfgCache ? "config-terbaca" : "config-tidak-terbaca",
    limits,
    models: modelRows,
  };
}

function getStats(port: number) {
  const now = Date.now();
  if (fastCache && now - fastCache.at < FAST_TTL) {
    return fastCache.data;
  }
  const today = startOfLocalDay();
  const week = startOfLocalDay(-6);
  const data = {
    ok: !!db,
    error: db ? undefined : `DB tidak bisa dibuka: ${DB_PATH}`,
    serverTime: now,
    port,
    overview: {
      all: overview(null),
      today: overview(today),
      week: overview(week),
    },
    live: getLive(),
    trend: computeTrend(),
    models: computeModels(),
    projects: computeProjects(),
    tools: computeTools(),
    recent: computeRecent(),
    limits: computeLimits(),
  };

  fastCache = { at: now, data };
  return data;
}

function bumpLive() {
  if (fastCache && Date.now() - fastCache.at > 250) fastCache = null;
}

export const tokenMonitor = async function () {
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch (e) {
    console.error(`[token-monitor] gagal buka DB ${DB_PATH}: ${String(e)}`);
  }
  server = startServer();

  return {
    event: async ({ event }: { event: any }) => {
      try {
        if (
          event?.type === "session.updated" ||
          event?.type === "session.created" ||
          event?.type === "message.updated"
        ) {
          bumpLive();
        }
      } catch (e) {
        console.error(`[token-monitor] event handler error: ${String(e)}`);
      }
    },
    dispose: async () => {
      try {
        server?.stop(true);
      } catch { /* ignore */ }
      try {
        db?.close();
      } catch { /* ignore */ }
      fastCache = null;
      slowCache = null;
    },
  };
};

const PAGE = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode · token monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root{
    --bg:#0b0f17;--card:#131a26;--card2:#0f1520;--line:#1f2b3d;
    --txt:#e6edf7;--mut:#8fa3bf;--ac:#4f8cff;--grn:#34d399;--amb:#fbbf24;--vio:#a78bfa;--teal:#2dd4bf;--red:#f87171;
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--txt)}
  .wrap{max-width:1180px;margin:0 auto;padding:20px}
  header{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  header h1{font-size:18px;margin:0;font-weight:700}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--grn);display:inline-block}
  .pill{font-size:12px;color:var(--mut);border:1px solid var(--line);border-radius:99px;padding:2px 10px;background:var(--card2)}
  .pill b{color:var(--ac)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .card .lb{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .card .vl{font-size:20px;font-weight:700;margin-top:4px}
  .card .vl small{font-size:12px;color:var(--mut);font-weight:400}
  .ac{color:var(--ac)}.grn{color:var(--grn)}.amb{color:var(--amb)}.vio{color:var(--vio)}.teal{color:var(--teal)}.red{color:var(--red)}
  .grid2{display:grid;grid-template-columns:1.6fr 1fr;gap:12px;margin-bottom:12px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .panel h2{font-size:13px;margin:0 0 10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td.tr,th.tr{text-align:right}
  tr:hover td{background:#151d2b}
  .muted{color:var(--mut)}
  .livebox{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--card2);margin-bottom:8px}
  .livebox .t{font-weight:700;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .livegrid{display:grid;grid-template-columns:repeat(4,auto);gap:8px;margin-top:8px}
  .livegrid div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 8px;text-align:center}
  .livegrid .lb{font-size:10px;color:var(--mut)}
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  .full{grid-column:1/-1}
  .cbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;min-height:0}
  footer{color:var(--mut);font-size:11px;margin-top:16px}
  .warn{color:var(--red);border:1px solid var(--red);border-radius:10px;padding:10px;margin-bottom:12px}
  @media(max-width:860px){.grid2,.charts{grid-template-columns:1fr}.livegrid{grid-template-columns:repeat(2,auto)}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>opencode <span class="muted">·</span> token monitor</h1>
    <span class="pill"><span class="dot"></span> server: <b>http://127.0.0.1:8590</b></span>
    <span class="pill" id="stamp">menunggu data…</span>
  </header>

  <div id="err" class="warn" style="display:none"></div>

  <div class="cards" id="cards"></div>

  <div class="grid2">
    <div class="panel">
      <h2>Sesi berjalan</h2>
      <div id="live"><div class="muted">beltum ada sesi aktif</div></div>
    </div>
    <div class="panel">
      <h2>Proyek (input token)</h2>
      <div id="projects"></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h2>Batasan limit · settingan hemat &amp; provider</h2>
    <div class="grid2" style="margin:0">
      <div>
        <h2>Config hemat (opencode.jsonc)</h2>
        <table>
          <thead><tr><th>Pengaturan</th><th>Nilai</th></tr></thead>
          <tbody id="limitsCfg"></tbody>
        </table>
      </div>
      <div>
        <h2>Model &amp; rate limit</h2>
        <table>
          <thead><tr><th>Model</th><th>Context</th><th class="tr">Rate / pakai</th><th class="tr">Input</th></tr></thead>
          <tbody id="limitsModel"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="charts">
    <div class="cbox full"><h2 class="panel" style="margin:0 0 10px;border:0;padding:0">Tren 30 hari (token & sesi)</h2><canvas id="trendChart" height="90"></canvas></div>
    <div class="cbox"><h2 class="panel" style="margin:0 0 10px;border:0;padding:0">Input per model</h2><canvas id="modelChart" height="160"></canvas></div>
    <div class="cbox"><h2 class="panel" style="margin:0 0 10px;border:0;padding:0">Pemakaian tool · 7 hari</h2><canvas id="toolChart" height="160"></canvas></div>
  </div>

  <div class="panel">
    <h2>Sesi terbaru</h2>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Waktu</th><th>Judul</th><th>Direktori</th><th>Model</th>
          <th class="tr">Input</th><th class="tr">Output</th><th class="tr">Cache</th>
        </tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </div>
  </div>

  <footer>Data dibaca read-only dari <code>~/.local/share/opencode/opencode.db</code>. Hanya bind <code>127.0.0.1</code> — tidak bisa diakses dari luar mesin.</footer>
</div>
<script>
const fmtTok = n => {
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
  return String(n);
};
const fmtTokF = n => {
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(2) + 'k';
  return String(n);
};
const ago = t => {
  const d = Date.now() - t; if (d < 6e4) return 'baru saja';
  if (d < 36e5) return Math.floor(d/6e4) + ' mnt lalu';
  if (d < 864e5) return Math.floor(d/36e5) + ' jam lalu';
  return Math.floor(d/864e5) + ' hari lalu';
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const C = {
  in: '#4f8cff', out: '#a78bfa', cache: '#2dd4bf', cost: '#fbbf24',
  grid: 'rgba(143,163,191,.12)', tick: '#8fa3bf',
};
Chart.defaults.color = '#8fa3bf';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

let trendChart, modelChart, toolChart;
const PALETTE = ['#4f8cff','#a78bfa','#2dd4bf','#fbbf24','#34d399','#f87171','#fb923c','#60a5fa','#c084fc','#22d3ee'];

function mkTrend(el, data){
  const labels = data.map(d=>d.date.slice(5));
  const cfg = {
    type:'bar',
    data:{labels, datasets:[
      {label:'Input', data:data.map(d=>d.input), backgroundColor:'#4f8cff', stack:'t'},
      {label:'Output', data:data.map(d=>d.output), backgroundColor:'#a78bfa', stack:'t'},
      {label:'Cache read', data:data.map(d=>d.cacheRead), backgroundColor:'#2dd4bf', stack:'t'},
    ]},
    options:{scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,ticks:{callback:v=>fmtTok(v)}}},interaction:{mode:'index',intersect:false},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmtTokF(c.parsed.y)+' token'}}}}
  };
  trendChart = new Chart(el, cfg);
}

function mkModel(modelChartEl, models){
  const labels = models.map(m=>m.model);
  const data = models.map(m=>m.input);
  const chart = new Chart(modelChartEl,{
    type:'doughnut',
    data:{labels, datasets:[{data, backgroundColor:PALETTE, borderColor:'#131a26', borderWidth:2}]},
    options:{cutout:'62%',plugins:{legend:{position:'right'},tooltip:{callbacks:{label:c=>c.label+': '+fmtTok(c.parsed[0])+' token'}}}}
  });
  modelChart = chart;
}

function mkTool(el, tools){
  if (!tools.length) return;
  const top = tools.slice(0,10).reverse();
  toolChart = new Chart(el,{
    type:'bar',
    data:{labels:top.map(t=>t.tool), datasets:[{label:'panggilan', data:top.map(t=>t.n), backgroundColor:PALETTE}]},
    options:{indexAxis:'y',scales:{x:{ticks:{precision:0}},y:{grid:{display:false}}},plugins:{legend:{display:false}}}
  });
}

function renderCards(o){
  const mk = (lb, vl, cls='') => \`<div class="card"><div class="lb">\${lb}</div><div class="vl \${cls}">\${vl}</div></div>\`;
  const a = o.all, t = o.today, w = o.week;
  document.getElementById('cards').innerHTML =
    mk('Input token (all)', fmtTok(a.tin)) +
    mk('Output token (all)', fmtTok(a.tout)) +
    mk('Cache read (all)', fmtTok(a.tcach_r), 'teal') +
    mk('Sesi (all)', a.sessions) +
    mk('Hari ini', fmtTok(t.tin), 'ac') +
    mk('7 hari', fmtTok(w.tin), 'vio') +
    mk('Sesi hari ini', t.sessions);
}

function renderLive(l){
  const el = document.getElementById('live');
  if (!l){ el.innerHTML = '<div class="muted">tidak ada sesi aktif</div>'; return; }
  el.innerHTML = \`
    <div class="livebox">
      <div class="t">\${esc(l.title)}</div>
      <div class="muted" style="font-size:11px">\${esc(l.model)} · \${esc(l.directory)} · diperbarui \${ago(l.updated)}</div>
      <div class="livegrid">
        <div><div class="lb">input</div>\${fmtTok(l.tokens.input)}</div>
        <div><div class="lb">output</div>\${fmtTok(l.tokens.output)}</div>
        <div><div class="lb">reasoning</div>\${fmtTok(l.tokens.reasoning)}</div>
        <div><div class="lb">cache</div>\${fmtTok(l.tokens.cacheRead)}</div>
      </div>
    </div>\`;
}

function renderProjects(ps){
  const el = document.getElementById('projects');
  if (!ps.length){ el.innerHTML = '<div class="muted">belum ada data</div>'; return; }
  const max = Math.max(...ps.map(p=>p.input), 1);
  el.innerHTML = ps.slice(0,8).map(p => \`
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span>\${esc(p.name)}</span><span class="muted">\${fmtTok(p.input)}<span class="muted"> · \${p.sessions} sesi</span></span>
      </div>
      <div style="height:6px;background:var(--line);border-radius:3px;margin-top:4px">
        <div style="height:6px;width:\${Math.round(p.input/max*100)}%;background:var(--ac);border-radius:3px"></div>
      </div>
    </div>\`).join('');
}

function renderRecent(rs){
  const el = document.getElementById('recent');
  if (!rs.length){ el.innerHTML = '<tr><td colspan="7" class="muted">kosong</td></tr>'; return; }
  el.innerHTML = rs.map(r => \`
    <tr>
      <td class="muted">\${ago(r.updated)}</td>
      <td title="\${esc(r.id)}">\${esc(r.title)}</td>
      <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">\${esc(r.directory)}</td>
      <td class="muted">\${esc(r.model)}</td>
      <td class="tr">\${fmtTok(r.input)}</td>
      <td class="tr">\${fmtTok(r.output)}</td>
      <td class="tr teal">\${fmtTok(r.cacheRead)}</td>
    </tr>\`).join('');
}

function renderLimits(ls){
  const cfgEl = document.getElementById('limitsCfg');
  const mdlEl = document.getElementById('limitsModel');
  if (!ls || !Array.isArray(ls.limits)) return;
  cfgEl.innerHTML = ls.limits.map(r => \`
    <tr>
      <td class="muted">\${esc(r.spec)}</td>
      <td>\${esc(r.value)}</td>
    </tr>\`).join('');
  mdlEl.innerHTML = ls.models.map(m => \`
    <tr>
      <td title="\${esc(m.rate)}">\${esc(m.id)}</td>
      <td class="muted">\${esc(m.context)}</td>
      <td class="tr muted">\${esc(m.rate)}</td>
      <td class="tr">\${fmtTok(m.tin)}</td>
    </tr>\`).join('');
}

function render(data){
  const errEl = document.getElementById('err');
  if (!data.ok){ errEl.style.display = 'block'; errEl.textContent = data.error || 'data tidak tersedia'; }
  else errEl.style.display = 'none';
  renderCards(data.overview);
  renderLive(data.live);
  renderProjects(data.projects);
  renderRecent(data.recent);
  renderLimits(data.limits);

  const c1 = document.getElementById('trendChart');
  const c2 = document.getElementById('modelChart');
  const c3 = document.getElementById('toolChart');
  try { trendChart?.destroy(); } catch {}
  mkTrend(c1, data.trend);
  try { modelChart?.destroy(); } catch {}
  mkModel(c2, data.models);
  try { toolChart?.destroy(); } catch {}
  mkTool(c3, data.tools);

  document.getElementById('stamp').textContent =
    'diperbarui ' + new Date(data.serverTime).toLocaleTimeString() + ' · sesi#' + data.overview.all.sessions;
}

async function load(){
  try {
    const r = await fetch('/api/stats');
    render(await r.json());
  } catch (e) {
    document.getElementById('err').style.display = 'block';
    document.getElementById('err').textContent = 'koneksi ke server gagal: ' + e;
  }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;