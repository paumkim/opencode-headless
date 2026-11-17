import { Effect } from "effect"
import { Tool } from "@opencode/plugin/effect"
import type { Manager } from "./manager.js"
import { parseModel } from "./instance.js"
import {
  CaptureInput,
  CaptureOutput,
  EventsInput,
  EventsOutput,
  PromptInput,
  PromptOutput,
  SendInput,
  SendOutput,
  StartInput,
  StartOutput,
  StatusInput,
  StatusOutput,
  StopInput,
  StopOutput,
  WaitInput,
  WaitOutput,
} from "./schema.js"

const DEFAULT_PROMPT_TIMEOUT_MS = 600_000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_TAIL = 200
const DEFAULT_EVENT_LIMIT = 100

function toolError(cause: unknown) {
  return new Tool.Error({ message: cause instanceof Error ? cause.message : String(cause) })
}

function attempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: toolError })
}

function attemptSync<A>(run: () => A) {
  return Effect.try({ try: run, catch: toolError })
}

function defineTool<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any>>(
  tool: Tool.Info<Input, Output>,
) {
  return tool
}

/** All nine tools. They are stateful and long-running, so none is codemode-eligible. */
export function headlessTools(manager: Manager): readonly Tool.Info[] {
  return [
    defineTool({
      name: "headless_start",
      description:
        "Start another OpenCode instance in its own working directory. mode api starts a private child server and is the default; cli runs one `opencode run` per prompt; pty runs the real TUI in a pseudo-terminal. The child is isolated: it gets its own XDG_STATE_HOME and never registers into this host's service file. Names are idempotent, so starting an existing name is an error. Set auto: true only when you accept that the child will execute tools without asking.",
      input: StartInput,
      output: StartOutput,
      options: { codemode: false },
      execute: (input) =>
        attempt(async () => {
          const instance = await manager.start(input)
          return {
            output: {
              name: instance.name,
              mode: instance.mode,
              pid: instance.pid ?? null,
              cwd: instance.cwd,
              url: instance.url,
              sessionID: instance.currentSession,
            },
          }
        }),
    }),
    defineTool({
      name: "headless_prompt",
      description:
        "Send a message to a headless instance and wait for it to go idle. Returns the assistant text, or status timeout with the partial text when timeoutMs elapses. A timeout never kills the child: inspect it with headless_events and stop it with headless_stop. Defaults: timeoutMs 600000, wait true.",
      input: PromptInput,
      output: PromptOutput,
      options: { codemode: false },
      execute: (input) =>
        attempt(async () => {
          const request = {
            message: input.message,
            timeoutMs: input.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
            wait: input.wait ?? true,
            ...(input.session === undefined ? {} : { session: input.session }),
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.model === undefined ? {} : { model: parseModel(input.model) }),
          }
          const result = await manager.prompt(input.name, request)
          return { output: result }
        }),
    }),
    defineTool({
      name: "headless_events",
      description:
        "Read the normalised event log of an instance: message, tool, permission, error and idle. Summaries are one bounded line, never raw wire JSON. Page with since = since + returned length.",
      input: EventsInput,
      output: EventsOutput,
      options: { codemode: false },
      execute: (input) =>
        attemptSync(() => ({
          output: manager.events(input.name, input.since ?? 0, input.limit ?? DEFAULT_EVENT_LIMIT),
        })),
    }),
    defineTool({
      name: "headless_capture",
      description:
        "Read the instance's captured output as text, ansi or json. text and json keep the last `tail` lines (default 200) and set truncated when they drop any. ansi is pty-only and returns an error in api or cli mode.",
      input: CaptureInput,
      output: CaptureOutput,
      options: { codemode: false },
      execute: (input) =>
        attemptSync(() => ({
          output: manager.capture(input.name, input.format ?? "text", input.tail ?? DEFAULT_TAIL),
        })),
    }),
    defineTool({
      name: "headless_send",
      description:
        "Send raw keys and optional literal text to a pty instance. Keys: enter, escape, ctrl-c, up, down, tab, y, n. Only pty mode has a keyboard; other modes return an error. Text is written literally, never shell-interpreted.",
      input: SendInput,
      output: SendOutput,
      options: { codemode: false },
      execute: (input) =>
        attemptSync(() => ({
          output: manager.send(input.name, input.keys ?? [], input.text),
        })),
    }),
    defineTool({
      name: "headless_wait",
      description:
        "Block until captured text contains `visible`, or until the instance is not busy with idle: true, whichever you ask for. Returns matched false when timeoutMs (default 30000) elapses. Event-driven, never a fixed sleep.",
      input: WaitInput,
      output: WaitOutput,
      options: { codemode: false },
      execute: (input) =>
        attempt(async () => {
          if (input.visible === undefined && input.idle === undefined)
            throw new Error("headless_wait needs `visible`, `idle: true`, or both")
          return {
            output: await manager.wait(input.name, {
              ...(input.visible === undefined ? {} : { visible: input.visible }),
              ...(input.idle === undefined ? {} : { idle: input.idle }),
              timeoutMs: input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
            }),
          }
        }),
    }),
    defineTool({
      name: "headless_status",
      description:
        "Inspect instances without changing them. Returns one entry per instance (or only the named one): mode, pid, alive, cwd, busy, startedAt, sessionID, url and the tools the child has called.",
      input: StatusInput,
      output: StatusOutput,
      options: { codemode: false },
      execute: (input) => attemptSync(() => ({ output: manager.status(input.name) })),
    }),
    defineTool({
      name: "headless_stop",
      description:
        "Stop one instance, or every instance this plugin owns when name is omitted. Sends SIGTERM and waits 5s. With force: false a surviving child is reported stopped: false and left running; with force: true it is SIGKILLed. Always reaps what it can.",
      input: StopInput,
      output: StopOutput,
      options: { codemode: false },
      execute: (input) =>
        attempt(async () => ({ output: await manager.stop(input.name, input.force ?? false) })),
    }),
  ]
}
