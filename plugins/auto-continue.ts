import type { Plugin } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";

type Client = ReturnType<typeof createOpencodeClient>;

const AGENT = "extreme";
const IDLE_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_IDLE_MS ?? 3 * 60_000);
const CHECK_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_CHECK_MS ?? 30_000);
const MIN_SEND_INTERVAL = Number(process.env.OPENCODE_AUTO_CONTINUE_MIN_GAP_MS ?? 45_000);
const MAX_CONSECUTIVE = Number(process.env.OPENCODE_AUTO_CONTINUE_MAX ?? 5);
const BACKOFF_MS = Number(process.env.OPENCODE_AUTO_CONTINUE_BACKOFF_MS ?? 30 * 60_000);
const PRUNE_MS = 4 * 60 * 60_000;
const MARKER = "[auto-continue]";
const CONTINUE_TEXT =
  `${MARKER} Lanjutkan pekerjaanmu sekarang. Jangan berhenti sampai semua todos selesai. ` +
  `Resume dari posisi terakhir; jangan mengulang bagian yang sudah jadi, jangan bertanya.`;

type Watch = {
  agent: string | null;
  runActive: boolean;
  pendingTools: number;
  lastActivity: number;
  autoSends: number;
  lastAutoSend: number;
  exhaustedAt: number;
};

const sessions = new Map<string, Watch>();

function getWatch(sessionID: string): Watch | null {
  if (!sessionID) return null;
  let w = sessions.get(sessionID);
  if (!w) {
    w = {
      agent: null,
      runActive: false,
      pendingTools: 0,
      lastActivity: Date.now(),
      autoSends: 0,
      lastAutoSend: 0,
      exhaustedAt: 0,
    };
    sessions.set(sessionID, w);
  }
  return w;
}

function isExtreme(w: Watch): boolean {
  return w.agent === AGENT;
}

function bump(w: Watch): void {
  w.lastActivity = Date.now();
}

function pendingAdd(w: Watch, delta: number): void {
  w.pendingTools = Math.max(0, w.pendingTools + delta);
}

async function incompleteTodos(client: Client, sessionID: string): Promise<boolean> {
  const res: any = await client.session.todo({ path: { id: sessionID } });
  const todos = res?.data ?? res?.todos ?? null;
  if (!Array.isArray(todos) || todos.length === 0) return false;
  return todos.some(
    (t: any) => t?.status != null && t.status !== "completed" && t.status !== "cancelled",
  );
}

async function sendContinue(client: Client, sessionID: string, w: Watch): Promise<void> {
  await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: CONTINUE_TEXT }] },
  });
  w.lastAutoSend = Date.now();
  w.autoSends += 1;
}

async function tick(client: Client): Promise<void> {
  const now = Date.now();
  for (const [sessionID, w] of sessions) {
    try {
      if (now - w.lastActivity > PRUNE_MS && w.pendingTools === 0) {
        sessions.delete(sessionID);
        continue;
      }
      if (!isExtreme(w)) continue;
      if (w.exhaustedAt && now < w.exhaustedAt) continue;
      if (w.pendingTools > 0) continue;
      if (now - w.lastActivity < IDLE_MS) continue;
      if (now - w.lastAutoSend < MIN_SEND_INTERVAL) continue;

      let needsRun = w.runActive;
      if (!needsRun) needsRun = await incompleteTodos(client, sessionID);
      if (!needsRun) continue;

      if (w.autoSends >= MAX_CONSECUTIVE) {
        w.exhaustedAt = now + BACKOFF_MS;
        continue;
      }

      if (w.runActive) {
        try {
          await client.session.abort({ path: { id: sessionID } });
        } catch { /* best effort */ }
      }
      await sendContinue(client, sessionID, w);
      w.lastActivity = Date.now();
    } catch (e) {
      console.error(`[auto-continue] tick ${sessionID}: ${String(e)}`);
    }
  }
}

export const autoContinue: Plugin = async ({ client }: { client: Client }) => {
  const timer = setInterval(() => tick(client).catch(() => {}), CHECK_MS);
  tick(client).catch(() => {});

  return {
    dispose: async () => {
      clearInterval(timer);
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
        if (!auto) {
          w.agent = agent ?? null;
          w.runActive = true;
          w.lastActivity = Date.now();
          w.autoSends = 0;
          w.exhaustedAt = 0;
        }
      } catch { /* ignore */ }
    },
    event: async ({ event }: any) => {
      try {
        const type = event?.type;
        const p: any = event?.properties ?? {};
        if (type === "session.created" || type === "session.updated") {
          const w = p.info?.id ? getWatch(p.info.id) : null;
          if (w) bump(w);
        } else if (type === "session.status") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.runActive = (p.status as any)?.type === "busy";
          bump(w);
        } else if (type === "session.idle") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          w.runActive = false;
          bump(w);
        } else if (type === "message.updated") {
          const w = getWatch(p.info?.sessionID);
          if (!w) return;
          bump(w);
        } else if (type === "message.part.updated") {
          const w = getWatch(p.part?.sessionID);
          if (!w) return;
          bump(w);
        } else if (type === "todo.updated") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          bump(w);
        } else if (type === "tool.execute.before") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          pendingAdd(w, +1);
          bump(w);
        } else if (type === "tool.execute.after") {
          const w = getWatch(p.sessionID);
          if (!w) return;
          pendingAdd(w, -1);
          bump(w);
        }
      } catch { /* ignore */ }
    },
  };
};