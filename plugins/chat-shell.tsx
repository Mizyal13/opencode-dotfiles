/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { homedir } from "node:os"

const ID = "chat-shell"
const HOME_ROUTE = "chat-home"
const HISTORY_LIMIT = 40
const SIDEBAR_LIMIT = 8

const LOGO = [
  "┌┬┐┬┌─┐┬ ┬┌─┐┬    ┌─┐┌─┐┌─┐┌┐┌┌┬┐",
  "││││┌─┘└┬┘├─┤│    ├─┤│ ┬├┤ │││ │ ",
  "┴ ┴┴└─┘ ┴ ┴ ┴┴─┘  ┴ ┴└─┘└─┘┘└┘ ┴",
]

const PLACEHOLDERS = {
  normal: ["Apa yang mau dikerjakan?", "Perbaiki bug di project ini", "Jelaskan struktur project"],
  shell: ["ls -la", "git status", "pwd"],
}

type Session = {
  id: string
  title: string
  parentID?: string
  time: {
    created: number
    updated: number
  }
}

type HistoryBucket = "today" | "yesterday" | "week" | "month" | "older"

type HistorySection = {
  key: HistoryBucket
  label: string
  items: Session[]
}

const HISTORY_SECTIONS: ReadonlyArray<{ key: HistoryBucket; label: string }> = [
  { key: "today", label: "Hari ini" },
  { key: "yesterday", label: "Kemarin" },
  { key: "week", label: "7 hari terakhir" },
  { key: "month", label: "30 hari terakhir" },
  { key: "older", label: "Lebih lama" },
]

function abbreviate(input: string): string {
  const home = homedir()
  if (!input) return ""
  if (input === home) return "~"
  if (input.startsWith(home + "/")) return "~" + input.slice(home.length)
  return input
}

function folderName(input: string): string {
  const parts = input.split("/").filter(Boolean)
  return parts.at(-1) ?? input
}

function clip(input: string, max: number): string {
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function bucketOf(value: number): HistoryBucket {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(value)) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return "week"
  if (days < 30) return "month"
  return "older"
}

function relativeTime(value: number): string {
  const minutes = Math.floor((Date.now() - value) / 60_000)
  if (minutes < 1) return "baru"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}j`
  const days = Math.floor(hours / 24)
  if (days === 1) return "kemarin"
  if (days < 7) return `${days}h`
  const date = new Date(value)
  return `${date.getDate()}/${date.getMonth() + 1}`
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function historyStamp(value: number, bucket: HistoryBucket): string {
  const date = new Date(value)
  if (bucket === "today") return relativeTime(value)
  if (bucket === "yesterday") return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (bucket === "week") return ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"][date.getDay()]
  if (bucket === "month") return `${date.getDate()}/${date.getMonth() + 1}`
  return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(-2)}`
}

function sessionTitle(session: Session): string {
  const title = session.title?.trim()
  return title ? title : "Sesi baru"
}

function useSessions(api: TuiPluginApi) {
  const [items, setItems] = createSignal<Session[]>([])
  const [loading, setLoading] = createSignal(true)
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let request = 0
  let lastDirectory = ""

  const load = async (directory = api.state.path.directory, silent = false) => {
    if (!directory) {
      if (alive) {
        setItems([])
        setLoading(false)
      }
      return
    }

    const id = ++request
    if (!silent) setLoading(true)
    try {
      const result = await api.client.session.list({
        directory,
        roots: true,
        limit: HISTORY_LIMIT,
      })
      if (!alive || id !== request) return
      const list = ((result as { data?: Session[] }).data ?? []) as Session[]
      setItems(
        [...list].sort(
          (a, b) =>
            b.time.updated - a.time.updated ||
            b.time.created - a.time.created ||
            b.id.localeCompare(a.id),
        ),
      )
    } catch {
      if (alive && id === request && !silent) setItems([])
    } finally {
      if (alive && id === request) setLoading(false)
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(undefined, true), 200)
  }

  createEffect(() => {
    const directory = api.state.path.directory
    if (!directory || directory === lastDirectory) return
    lastDirectory = directory
    void load(directory)
  })

  onMount(() => {
    const offs = [
      api.event.on("session.created", schedule),
      api.event.on("session.updated", schedule),
      api.event.on("session.deleted", schedule),
    ]
    onCleanup(() => {
      alive = false
      if (timer) clearTimeout(timer)
      for (const off of offs) off()
    })
  })

  return { items, loading }
}

function HistoryRow(props: {
  api: TuiPluginApi
  session: Session
  bucket: HistoryBucket
  active: boolean
  width: number
  onOpen: () => void
}) {
  const theme = () => props.api.theme.current
  const status = () => props.api.state.session.status(props.session.id)?.type
  const busy = () => status() === "busy" || status() === "retry"
  const titleWidth = () => Math.max(10, props.width - 13)

  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? theme().backgroundElement : undefined}
      onMouseUp={() => props.onOpen()}
    >
      <text fg={busy() ? theme().accent : theme().textMuted} wrapMode="none" selectable={false}>
        {busy() ? "●" : "·"}
      </text>
      <box flexGrow={1} minWidth={0}>
        <text fg={props.active ? theme().accent : theme().text} wrapMode="none" selectable={false}>
          {clip(sessionTitle(props.session), titleWidth())}
        </text>
      </box>
      <text fg={theme().textMuted} wrapMode="none" selectable={false}>
        {historyStamp(props.session.time.updated, props.bucket)}
      </text>
    </box>
  )
}

function HistoryPanel(props: {
  api: TuiPluginApi
  width: number
  current?: string
  compact?: boolean
  onNew: () => void
}) {
  const api = props.api
  const theme = () => api.theme.current
  const { items, loading } = useSessions(api)
  const sections = createMemo<HistorySection[]>(() => {
    const list = items()
      .filter((session) => session.id !== props.current)
      .slice(0, props.compact ? SIDEBAR_LIMIT : HISTORY_LIMIT)
    const grouped = new Map<HistoryBucket, Session[]>()
    for (const session of list) {
      const bucket = bucketOf(session.time.updated)
      const group = grouped.get(bucket) ?? []
      group.push(session)
      grouped.set(bucket, group)
    }
    return HISTORY_SECTIONS.flatMap((section) => {
      const group = grouped.get(section.key)
      return group ? [{ ...section, items: group }] : []
    })
  })
  const open = (id: string) => api.route.navigate("session", { sessionID: id })

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text} selectable={false}>
          <b>Riwayat</b>
        </text>
        <box flexGrow={1} />
        <box onMouseUp={() => props.onNew()}>
          <text fg={theme().accent} selectable={false}>
            + Baru
          </text>
        </box>
      </box>
      <Show
        when={!loading()}
        fallback={
          <text fg={theme().textMuted} paddingLeft={1} selectable={false}>
            Memuat riwayat…
          </text>
        }
      >
        <Show
          when={sections().length > 0}
          fallback={
            <text fg={theme().textMuted} paddingLeft={1} selectable={false}>
              {props.compact ? "Belum ada chat lain." : "Belum ada riwayat di folder ini."}
            </text>
          }
        >
          <For each={sections()}>
            {(section, index) => (
              <box flexDirection="column" flexShrink={0} paddingTop={index() === 0 ? 0 : 1}>
                <box paddingLeft={1} paddingRight={1} flexShrink={0}>
                  <text fg={theme().textMuted} wrapMode="none" selectable={false}>
                    {section.label.toUpperCase()}
                  </text>
                </box>
                <For each={section.items}>
                  {(session) => (
                    <HistoryRow
                      api={api}
                      session={session}
                      bucket={section.key}
                      active={session.id === props.current}
                      width={props.width}
                      onOpen={() => open(session.id)}
                    />
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>
      </Show>
      <box paddingLeft={1} paddingTop={0} flexShrink={0}>
        <text fg={theme().textMuted} wrapMode="none" selectable={false}>
          {props.compact ? "/sessions untuk semua sesi" : "Terbaru di atas · klik untuk lanjut"}
        </text>
      </box>
    </box>
  )
}

function HomeShell(props: { api: TuiPluginApi }) {
  const api = props.api
  const theme = () => api.theme.current
  const dimensions = useTerminalDimensions()
  const [promptRef, setPromptRef] = createSignal<TuiPromptRef | undefined>()
  const Prompt = api.ui.Prompt
  const sidebarWidth = createMemo(() =>
    Math.max(22, Math.min(36, Math.floor(dimensions().width * 0.32))),
  )
  const directory = () => api.state.path.directory
  const branch = () => api.state.vcs?.branch

  return (
    <box flexGrow={1} flexDirection="row" minHeight={0}>
      <box
        width={sidebarWidth()}
        flexShrink={0}
        flexDirection="column"
        gap={1}
        backgroundColor={theme().backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexShrink={0} flexDirection="column" gap={0} paddingLeft={1}>
          <text fg={theme().text} wrapMode="none" selectable={false}>
            <b>{folderName(directory())}</b>
          </text>
          <text fg={theme().textMuted} wrapMode="none" selectable={false}>
            {abbreviate(directory())}
          </text>
          <Show when={branch()}>
            {(value) => (
              <text fg={theme().accent} wrapMode="none" selectable={false}>
                {value()}
              </text>
            )}
          </Show>
        </box>

        <box
          flexShrink={0}
          border
          borderColor={theme().borderSubtle}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => promptRef()?.reset()}
        >
          <text fg={theme().accent} selectable={false}>
            + New chat
          </text>
        </box>

        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: true }}>
          <HistoryPanel
            api={api}
            width={sidebarWidth() - 4}
            onNew={() => promptRef()?.reset()}
          />
        </scrollbox>

        <text fg={theme().textMuted} wrapMode="none" selectable={false} paddingLeft={1}>
          {api.app.version}
        </text>
      </box>

      <box flexGrow={1} minHeight={0} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box flexShrink={0} alignItems="center" gap={0}>
          <For each={LOGO}>
            {(line) => (
              <text fg={theme().primary} wrapMode="none" selectable={false}>
                {line}
              </text>
            )}
          </For>
          <text fg={theme().textMuted} wrapMode="none" selectable={false}>
            {abbreviate(directory())}
          </text>
        </box>
        <box height={1} flexShrink={0} />
        <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
          <Prompt
            ref={(value) => setPromptRef(value)}
            placeholders={PLACEHOLDERS}
          />
        </box>
        <box flexGrow={1} minHeight={0} />
        <text fg={theme().textMuted} wrapMode="none" selectable={false}>
          Sesi baru · pilih riwayat di kiri untuk melanjutkan
        </text>
        <box height={1} flexShrink={0} />
      </box>
    </box>
  )
}

function HomeRedirect(props: { api: TuiPluginApi }) {
  createEffect(() => {
    if (props.api.route.current.name === "home") {
      props.api.route.navigate(HOME_ROUTE)
    }
  })
  return null
}

function SidebarHistory(props: { api: TuiPluginApi; sessionID: string }) {
  return (
    <HistoryPanel
      api={props.api}
      width={36}
      current={props.sessionID}
      compact
      onNew={() => props.api.route.navigate(HOME_ROUTE)}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: HOME_ROUTE,
      render: () => <HomeShell api={api} />,
    },
  ])

  api.slots.register({
    order: 900,
    slots: {
      app() {
        return <HomeRedirect api={api} />
      },
      sidebar_content(_ctx, props) {
        return <SidebarHistory api={api} sessionID={props.session_id} />
      },
    },
  })

  api.command?.register(() => [
    {
      title: "New chat",
      value: "chat-shell.new",
      category: "Chat",
      description: "Buka layar sesi baru dengan riwayat",
      onSelect: () => api.route.navigate(HOME_ROUTE),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
