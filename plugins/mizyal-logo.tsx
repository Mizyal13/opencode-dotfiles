/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const LINES = [
  "┌┬┐┬┌─┐┬ ┬┌─┐┬    ┌─┐┌─┐┌─┐┌┐┌┌┬┐",
  "││││┌─┘└┬┘├─┤│    ├─┤│ ┬├┤ │││ │ ",
  "┴ ┴┴└─┘ ┴ ┴ ┴┴─┘  ┴ ┴└─┘└─┘┘└┘ ┴",
]

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      home_logo() {
        return (
          <box flexDirection="column" alignItems="center" gap={0}>
            {LINES.map((line) => (
              <text bold fg="#00BCD4">{line}</text>
            ))}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "mizyal-logo",
  tui,
}

export default plugin
