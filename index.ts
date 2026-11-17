import { Effect } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import { Manager } from "./src/manager.js"
import { headlessTools } from "./src/tools.js"

const DEFAULT_MAX_DEPTH = 3

function integer(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * `opencode.headless` gives the agent a tool surface for driving other OpenCode instances to completion.
 *
 * The manager is scoped: closing the plugin scope reaps every child it owns, and a last-resort `process.on("exit")`
 * hook covers a host that exits without unwinding its scopes. Nesting depth comes from the environment so a child
 * running this plugin refuses to fork further at the limit.
 */
export default Plugin.define({
  id: "opencode.headless",
  effect: Effect.fn(function* (ctx) {
    const manager = new Manager({
      roots: [ctx.location.directory, ctx.location.project.directory, ctx.location.project.canonical],
      depth: integer(process.env.OPENCODE_HEADLESS_DEPTH, 0),
      maxDepth: integer(process.env.OPENCODE_HEADLESS_MAX_DEPTH, DEFAULT_MAX_DEPTH),
      ...(process.env.OPENCODE_HEADLESS_BIN === undefined ? {} : { binary: process.env.OPENCODE_HEADLESS_BIN }),
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()).pipe(Effect.ignore))
    const reap = () => manager.reapSync()
    process.on("exit", reap)
    yield* Effect.addFinalizer(() => Effect.sync(() => void process.off("exit", reap)))
    yield* ctx.tool.transform((editor) => {
      headlessTools(manager).forEach((tool) => editor.add(tool))
    })
  }),
})