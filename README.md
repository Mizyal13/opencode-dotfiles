# opencode-dotfiles

A ready-to-use global configuration bundle for [opencode](https://opencode.ai).
Clone it once, and every computer gets the same agents, commands, plugins,
skills, and rules — no manual setup on each machine.

Repo: https://github.com/Mizyal13/opencode-dotfiles (private)

---

## What you get

| Item | What it does |
| --- | --- |
| `opencode.jsonc` | Global config: models, token-saving settings, and the custom `extreme` agent |
| `agent/extreme` | **extreme** primary agent (see below) |
| `agent/reviewer.md` | Strict code reviewer subagent, invoked via `@reviewer` or `/review` |
| `command/review.md` | Run a full code review with `/review` |
| `plugins/auto-continue.ts` | Watchdog that auto-resumes a stuck session until all todos are done |
| `plugins/token-monitor.ts` | Live usage dashboard (web UI) — includes a monitoring UI |
| `skill/ai-nota/` | Memory skill for the AI Nota project (Kasir/nota SAAS) |
| `AGENTS.md` | Global rules the AI must always follow |

> **Yes, the monitoring UI is included.** `token-monitor.ts` automatically
> starts a small web dashboard at **http://127.0.0.1:8590** so you can watch
> token usage, sessions, projects, models, and tool calls live in your browser.

---

## Prerequisites

- **opencode** (installed and on your `PATH`)
  - macOS: `brew install opencode`
  - Other: follow https://opencode.ai/docs/
- **Bun** (needed only to install the plugin dependencies) →
  https://bun.sh/

## Install / setup (any OS)

```bash
# 1. Clone into opencode's global config folder
git clone https://github.com/Mizyal13/opencode-dotfiles ~/.config/opencode

# 2. Install plugin dependencies (Bun creates node_modules)
cd ~/.config/opencode
bun install

# 3. Log in to your AI providers (credentials are never synced)
opencode auth login

# 4. Start opencode and you're done
opencode
```

> On Windows, `~/.config/opencode` maps to
> `%USERPROFILE%\.config\opencode`. Set it up there the same way.

## After an update

```bash
cd ~/.config/opencode && git pull
```

---

## Using the `extreme` agent

`extreme` is a "set it and forget it" agent for long tasks:

1. Switch to it: press **Tab** in opencode until the agent says `extreme`.
2. Type your task, for example: _"Update the login flow and add tests."_
3. Watch it run. It is designed to work like this:

   ```
   make a PLAN (short)  →  create TODOs  →  BUILD until ALL todos are done
   ```

What makes it different:
- **No questions.** It never asks for confirmation (`question` tool is
  denied); it picks the best option and acts.
- **Everything auto-allowed.** All tools (read, edit, bash, web, tasks, ...)
  run without permission prompts.
- **Keeps going until finished.** The built-in watchdog makes sure stalled
  sessions resume automatically.

> ⚠️ `extreme` edits and runs commands on its own. Only use it when you are
> comfortable handing over control.

---

## The auto-continue watchdog

Handles two annoying situations automatically:

1. **Stopped too early** — the agent stops mid-task while todos are still
   unfinished → it injects "continue" until every todo is done.
2. **Stuck spinner** — "rotating" with no progress for **3 minutes** → it
   aborts and resumes the run.

It skips interfering while a tool (build/test) is actively running.

Only sessions using the `extreme` agent are watched.

### Tuning (optional, via environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_AUTO_CONTINUE_IDLE_MS` | `180000` | Idle time before resuming (3 min) |
| `OPENCODE_AUTO_CONTINUE_MIN_GAP_MS` | `45000` | Minimum gap between auto-continues |
| `OPENCODE_AUTO_CONTINUE_MAX` | `5` | Max consecutive auto-continues, then back off |
| `OPENCODE_AUTO_CONTINUE_BACKOFF_MS` | `1800000` | Back off after max reached (30 min) |

Example:

```bash
OPENCODE_AUTO_CONTINUE_IDLE_MS=60000 opencode
```

---

## The monitoring UI

`token-monitor.ts` runs a read-only dashboard bound to localhost only.

| Endpoint | What you see |
| --- | --- |
| `http://127.0.0.1:8590` | Dashboard: live session, token totals (today/all/week), cost, 30-day trend, per-model usage, tool usage, recent sessions, config/limit summary |

It reads `~/.local/share/opencode/opencode.db` in **read-only** mode and never
sends data anywhere.

### Tuning (optional, via environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_MONITOR_PORT` | `8590` | Dashboard port (tries up to +20 if busy) |
| `OPENCODE_MONITOR_DB` | default path | SQLite database to read |
| `OPENCODE_MONITOR_CONFIG` | default path | Config file shown in the "limits" panel |

---

## Reviewing code

Run a thorough review of your latest changes:

```
/review
```

or ask directly: `@reviewer review the recent changes`.

The reviewer never edits files — it only reports findings with `file:line`
and severity (blocker / major / minor / nit).

---

## What is NOT synced (by design)

| What | Why |
| --- | --- |
| `auth.json` | Credentials — run `opencode auth login` on each machine |
| `opencode.db`, snapshots, logs | Runtime data, machine-specific |
| `node_modules` | Recreated automatically by `bun install` |
| Project MCP servers (e.g. `browser-use`) | Use absolute paths — set them up per machine |

---

## Troubleshooting

- **Blocked by permission?** Check you're on the `extreme` agent: press **Tab**
  to cycle agents.
- **Watchdog not resuming?** Make sure the session really uses the `extreme`
  agent, and give it a full 3 idle minutes.
- **Dashboard not opening?** Confirm the port (`8590` by default) and that
  opencode is running with the plugin (restart after `git pull`).