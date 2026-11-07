import type { Plugin } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Client = ReturnType<typeof createOpencodeClient>;

const MARKER = "[auto-continue]";
const STATE_PATH =
  process.env.OPENCODE_AUTO_CONTINUE_STATE ||
  join(homedir(), ".local/share/opencode/auto-continue-state.json");

const IDLE_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_IDLE_MS ?? 60_000);
const CHECK_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_CHECK_MS ?? 15_000);
const MIN_SEND_INTERVAL = Number(process.env.OPENCODE_AUTO_CONTINUE_MIN_GAP_MS ?? 60_000);
const MAX_CONSECUTIVE = Number(process.env.OPENCODE_AUTO_CONTINUE_MAX ?? 30);
const BACKOFF_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_BACKOFF_MS ?? 15 * 60_000);
const RATE_BACKOFF_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_RATE_BACKOFF_MS ?? 2 * 60_000);
const PRUNE_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_PRUNE_MS ?? 7 * 24 * 60 * 60_000);
const STARTUP_NOTICE_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_NOTICE_MS ?? 8_000);
const SAVE_DEBOUNCE_MS = 1_500;

const DEFAULT_AGENTS = ["extreme", "build"];
const AGENTS = new Set(
  (process.env.OPENCODE_AUTO_CONTINUE_AGENTS ?? DEFAULT_AGENTS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const ALL_AGENTS = AGENTS.has("*");
const FALLBACK_MODEL = (process.env.OPENCODE_FALLBACK_MODEL ?? "").trim();

type ErrorKind = "quota" | "network" | "aborted" | "output" | "other";

type Todo = { content: string; status: string };

type Watch = {
  id: string;
  agent: string | null;
  title: string;
  directory: string;
  status: "idle" | "busy" | "retry" | "unknown";
  pendingTools: number;
  lastActivity: number;
  idleSince: number;
  lastUserAt: number;
  autoSends: number;
  lastAutoSend: number;
  exhaustedAt: number;
  todos: Todo[];
  lastError: string;
  errorKind: ErrorKind | null;
  fallbackTried: boolean;
  compactedAt: number;
  updatedAt: number;
};

type PersistedState = {
  version: 1;
  lastSessionID: string | null;
  sessions: Record<string, Watch>;
};

const sessions = new Map<string, Watch>();
let lastSessionID: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
const seenErrors = new Set<string>();

function emptyWatch(id: string): Watch {
  const now = Date.now();
  return {
    id,
    agent: null,
    title: "",
    directory: "",
    status: "unknown",
    pendingTools: 0,
    lastActivity: now,
    idleSince: 0,
    lastUserAt: 0,
    autoSends: 0,
    lastAutoSend: 0,
    exhaustedAt: 0,
    todos: [],
    lastError: "",
    errorKind: null,
    fallbackTried: false,
    compactedAt: 0,
    updatedAt: now,
  };
}

function getWatch(id: string): Watch | null {
  if (!id) return null;
  let w = sessions.get(id);
  if (!w) {
    w = emptyWatch(id);
    sessions.set(id, w);
  }
  return w;
}

function trimTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t: any) => t && typeof t.content === "string")
    .slice(0, 30)
    .map((t: any) => ({ content: t.content.slice(0, 300), status: String(t.status ?? "") }));
}

function loadState(): void {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const data = JSON.parse(raw) as Partial<PersistedState>;
    if (data && data.version === 1) {
      lastSessionID = typeof data.lastSessionID === "string" ? data.lastSessionID : null;
      for (const [id, value] of Object.entries(data.sessions ?? {})) {
        if (!value || typeof value !== "object") continue;
        const w = { ...emptyWatch(id), ...(value as Watch), id };
        w.pendingTools = 0;
        w.status = "unknown";
        w.idleSince = 0;
        sessions.set(id, w);
      }
    }
  } catch {
    /* first run or unreadable state */
  }
}

function saveNow(): void {
  if (disposed) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const now = Date.now();
  const out: Record<string, Watch> = {};
  for (const [id, w] of sessions) {
    if (now - w.updatedAt > PRUNE_MS) {
      sessions.delete(id);
      continue;
    }
    out[id] = w;
  }
  const data: PersistedState = { version: 1, lastSessionID, sessions: out };
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, STATE_PATH);
  } catch (e) {
    console.error(`[auto-continue] gagal simpan state: ${String(e)}`);
  }
}

function scheduleSave(): void {
  if (disposed || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
}

function touch(w: Watch): void {
  w.lastActivity = Date.now();
  w.updatedAt = w.lastActivity;
  scheduleSave();
}

function isAllowed(w: Watch): boolean {
  if (!w.agent) return false;
  return ALL_AGENTS || AGENTS.has(w.agent.toLowerCase());
}

function hasIncompleteTodos(w: Watch): boolean {
  return w.todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
}

function classifyError(err: any): ErrorKind {
  const name = String(err?.name ?? "");
  const msg = String(err?.data?.message ?? err?.message ?? "");
  if (name === "MessageAbortedError") return "aborted";
  if (name === "MessageOutputLengthError") return "output";
  if (/free usage limit|quota|insufficient|billing|credit|payment required/i.test(msg)) return "quota";
  if (/rate.?limit|too many requests|status.?429/i.test(msg)) return "quota";
  if (
    /socket|econn|etimedout|timed out|timeout|connect|network|fetch failed|closed unexpectedly|overloaded/i.test(
      msg,
    )
  ) {
    return "network";
  }
  if (err?.data?.isRetryable === true) return "network";
  return "other";
}

function errorText(err: any): string {
  const msg = String(err?.data?.message ?? err?.message ?? err?.name ?? "unknown error");
  return msg.replace(/\s+/g, " ").slice(0, 500);
}

function parseModel(value: string): { providerID: string; modelID: string } | null {
  const idx = value.indexOf("/");
  if (idx <= 0 || idx >= value.length - 1) return null;
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) };
}

function continueText(w: Watch): string {
  const pending = w.todos
    .filter((t) => t.status !== "completed" && t.status !== "cancelled")
    .slice(0, 12)
    .map((t) => `- [${t.status || "pending"}] ${t.content}`)
    .join("\n");
  const todoBlock = pending ? `\nTodo yang belum selesai:\n${pending}` : "";
  return (
    `${MARKER} Lanjutkan pekerjaan dari posisi terakhir. ` +
    `Jangan mengulang bagian yang sudah selesai, jangan bertanya, dan selesaikan semua todo.${todoBlock}`
  );
}

async function hasIncompleteTodosRemote(client: Client, w: Watch): Promise<boolean> {
  if (w.todos.length > 0) return hasIncompleteTodos(w);
  try {
    const res: any = await client.session.todo({ path: { id: w.id } });
    const list = res?.data ?? res?.todos ?? [];
    w.todos = trimTodos(list);
    scheduleSave();
  } catch {
    return false;
  }
  return hasIncompleteTodos(w);
}

async function toast(client: Client, title: string, message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration: 12_000 },
    });
  } catch {
    /* non-TUI clients have no toast */
  }
}

async function sendContinue(client: Client, w: Watch, model?: { providerID: string; modelID: string }): Promise<void> {
  const body: any = { parts: [{ type: "text", text: continueText(w) }] };
  if (w.agent) body.agent = w.agent;
  if (model) body.model = model;
  await client.session.prompt({ path: { id: w.id }, body });
  const now = Date.now();
  w.lastAutoSend = now;
  w.autoSends += 1;
  w.idleSince = 0;
  w.status = "busy";
  w.lastActivity = now;
  w.updatedAt = now;
  scheduleSave();
}

async function handleError(client: Client, sessionID: string | undefined, err: any): Promise<void> {
  const id = sessionID || lastSessionID || "";
  if (!id) return;
  const w = getWatch(id);
  if (!w) return;
  const kind = classifyError(err);
  const msg = errorText(err);
  const key = `${id}:${kind}:${msg}`;
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  if (seenErrors.size > 500) seenErrors.clear();

  w.lastError = msg;
  w.errorKind = kind;
  w.updatedAt = Date.now();
  scheduleSave();

  if (kind === "quota") {
    await toast(
      client,
      "Kuota model habis",
      `Sesi "${w.title || id}" tersimpan. Ganti model lalu lanjut, atau buka lagi dengan: opencode -c`,
      "warning",
    );
  }
}

async function tick(client: Client): Promise<void> {
  const now = Date.now();
  for (const [id, w] of sessions) {
    if (now - w.updatedAt > PRUNE_MS && w.pendingTools === 0) sessions.delete(id);
  }

  let target = lastSessionID ? sessions.get(lastSessionID) : undefined;
  if (!target || !isAllowed(target)) {
    const anyBusy = [...sessions.values()].some(
      (s) => s.status === "busy" || s.status === "retry",
    );
    if (anyBusy) return;
    target = [...sessions.values()]
      .filter(isAllowed)
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  }
  if (!target) return;

  const w = target;
  try {
    if (!isAllowed(w)) return;
    if (w.status !== "idle") return;
    if (w.pendingTools > 0) return;
    if (!w.idleSince) return;
    if (now - w.idleSince < IDLE_MS) return;
    if (now - w.lastAutoSend < MIN_SEND_INTERVAL) return;
    if (w.exhaustedAt && now < w.exhaustedAt) return;

    if (w.errorKind === "aborted") return;

    if (w.errorKind === "quota") {
      const model = FALLBACK_MODEL ? parseModel(FALLBACK_MODEL) : null;
      if (!model || w.fallbackTried) {
        w.exhaustedAt = now + BACKOFF_MS;
        scheduleSave();
        return;
      }
      w.fallbackTried = true;
      await toast(
        client,
        "Pindah ke model fallback",
        `Kuota model utama habis. Mencoba lanjut dengan ${FALLBACK_MODEL}.`,
        "info",
      );
      await sendContinue(client, w, model);
      return;
    }

    if (w.errorKind === "network") {
      w.exhaustedAt = now + RATE_BACKOFF_MS;
      scheduleSave();
      return;
    }

    if (w.autoSends >= MAX_CONSECUTIVE) {
      w.exhaustedAt = now + BACKOFF_MS;
      scheduleSave();
      return;
    }

    if (!(await hasIncompleteTodosRemote(client, w))) return;
    await sendContinue(client, w);
  } catch (e) {
    console.error(`[auto-continue] tick ${w.id}: ${String(e)}`);
  }
}

export const autoContinue: Plugin = async ({ client }: { client: Client }) => {
  loadState();
  const timer = setInterval(() => tick(client).catch(() => {}), CHECK_MS);
  tick(client).catch(() => {});

  noticeTimer = setTimeout(() => {
    const w = lastSessionID ? sessions.get(lastSessionID) : null;
    if (!w || !hasIncompleteTodos(w)) return;
    const pending = w.todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
    toast(
      client,
      "Sesi belum selesai",
      `"${w.title || w.id}" punya ${pending} todo tersisa. Lanjut dengan opencode -c atau Ctrl+X L.`,
      "warning",
    ).catch(() => {});
  }, STARTUP_NOTICE_MS);

  return {
    dispose: async () => {
      clearInterval(timer);
      if (noticeTimer) clearTimeout(noticeTimer);
      saveNow();
      disposed = true;
      sessions.clear();
    },

    "chat.message": async ({ sessionID, agent }: any, { message, parts }: any) => {
      try {
        if (message?.role !== "user") return;
        const w = getWatch(sessionID);
        if (!w) return;
        const auto = (parts ?? []).some(
          (p: any) => p?.type === "text" && typeof p?.text === "string" && p.text.includes(MARKER),
        );
        if (auto) {
          touch(w);
          return;
        }
        const now = Date.now();
        w.agent = agent ?? w.agent ?? null;
        w.status = "busy";
        w.pendingTools = 0;
        w.lastActivity = now;
        w.lastUserAt = now;
        w.idleSince = 0;
        w.autoSends = 0;
        w.exhaustedAt = 0;
        w.errorKind = null;
        w.lastError = "";
        w.fallbackTried = false;
        w.updatedAt = now;
        lastSessionID = sessionID;
        scheduleSave();
      } catch {
        /* ignore */
      }
    },

    "tool.execute.before": async ({ sessionID }: any) => {
      try {
        const w = getWatch(sessionID);
        if (!w) return;
        w.pendingTools += 1;
        touch(w);
      } catch {
        /* ignore */
      }
    },

    "tool.execute.after": async ({ sessionID }: any) => {
      try {
        const w = getWatch(sessionID);
        if (!w) return;
        w.pendingTools = Math.max(0, w.pendingTools - 1);
        touch(w);
      } catch {
        /* ignore */
      }
    },

    event: async ({ event }: any) => {
      try {
        const type = event?.type;
        const p: any = event?.properties ?? {};

        if (type === "session.created" || type === "session.updated") {
          const info = p.info;
          if (!info?.id) return;
          const w = getWatch(info.id);
          if (!w) return;
          if (typeof info.title === "string" && info.title) w.title = info.title;
          if (typeof info.directory === "string" && info.directory) w.directory = info.directory;
          if (typeof info.agent === "string" && info.agent) w.agent = info.agent;
          touch(w);
          return;
        }

        if (type === "session.status") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          const status = p.status?.type;
          if (status === "busy") {
            w.status = "busy";
            w.idleSince = 0;
          } else if (status === "retry") {
            w.status = "retry";
            w.idleSince = 0;
            const msg = String(p.status?.message ?? "retry");
            w.lastError = msg.slice(0, 500);
            w.errorKind = classifyError({ data: { message: msg, isRetryable: true } });
            if (w.errorKind === "quota") {
              await handleError(client, p.sessionID, { name: "APIError", data: { message: msg, isRetryable: true } });
            }
          } else if (status === "idle") {
            w.status = "idle";
            w.idleSince = Date.now();
            w.pendingTools = 0;
          }
          touch(w);
          return;
        }

        if (type === "session.idle") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.status = "idle";
          w.idleSince = Date.now();
          w.pendingTools = 0;
          touch(w);
          return;
        }

        if (type === "session.compacted") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.compactedAt = Date.now();
          w.autoSends = 0;
          w.exhaustedAt = 0;
          w.idleSince = Date.now();
          touch(w);
          return;
        }

        if (type === "session.error") {
          await handleError(client, p.sessionID, p.error);
          return;
        }

        if (type === "message.updated") {
          const info = p.info;
          const w = getWatch(info?.sessionID);
          if (!w) return;
          if (info?.role === "assistant" && info?.error) {
            await handleError(client, info.sessionID, info.error);
          }
          touch(w);
          return;
        }

        if (type === "message.part.updated") {
          const w = getWatch(p.part?.sessionID);
          if (!w) return;
          touch(w);
          return;
        }

        if (type === "todo.updated") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.todos = trimTodos(p.todos);
          touch(w);
          return;
        }

        if (type === "session.deleted") {
          const id = p.info?.id;
          if (id) sessions.delete(id);
          if (id && lastSessionID === id) lastSessionID = null;
          scheduleSave();
          return;
        }

        if (type === "tool.execute.before") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.pendingTools += 1;
          touch(w);
          return;
        }

        if (type === "tool.execute.after") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.pendingTools = Math.max(0, w.pendingTools - 1);
          touch(w);
          return;
        }
      } catch (e) {
        console.error(`[auto-continue] event ${String(event?.type)}: ${String(e)}`);
      }
    },

    "experimental.session.compacting": async ({ sessionID }: any, output: any) => {
      const w = getWatch(sessionID);
      if (w) {
        w.compactedAt = Date.now();
        w.autoSends = 0;
        w.exhaustedAt = 0;
        scheduleSave();
      }
      output.context.push(
        "Pertahankan daftar todo yang belum selesai, file yang sudah diubah, keputusan penting, dan langkah berikutnya. " +
          "Setelah ringkasan, lanjutkan otomatis dari posisi terakhir tanpa mengulang pekerjaan yang sudah selesai.",
      );
    },

    "experimental.compaction.autocontinue": async ({ sessionID }: any, output: any) => {
      if (process.env.OPENCODE_COMPACTION_AUTOCONTINUE === "0") {
        output.enabled = false;
        return;
      }
      output.enabled = true;
      const w = getWatch(sessionID);
      if (w) {
        w.idleSince = Date.now();
        w.autoSends = 0;
        w.exhaustedAt = 0;
        scheduleSave();
      }
    },
  };
};
