import { Schema } from "effect"

// Inputs and outputs are validated once here, at the tool boundary. Everything inward is typed.
export const Mode = Schema.Literals(["api", "cli", "pty"] as const).annotate({
  identifier: "Headless.Mode",
  description:
    "api: a private `opencode serve` child driven over its HTTP API. cli: one `opencode run --format json` process per prompt. pty: the real TUI in a pseudo-terminal.",
})

export const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/u), Schema.isMaxLength(64)).annotate({
  identifier: "Headless.Name",
  description: "Unique instance name, lowercase letters, digits and hyphens.",
})

export type Mode = typeof Mode.Type

export const CaptureFormat = Schema.Literals(["text", "ansi", "json"] as const).annotate({
  identifier: "Headless.CaptureFormat",
})
export type CaptureFormat = typeof CaptureFormat.Type

export const Key = Schema.Literals(["enter", "escape", "ctrl-c", "up", "down", "tab", "y", "n"] as const).annotate({
  identifier: "Headless.Key",
})
export type Key = typeof Key.Type

export const StartInput = Schema.Struct({
  name: Name,
  cwd: Schema.String.annotate({ description: "Absolute working directory for the child." }),
  mode: Schema.optionalKey(Mode),
  model: Schema.optionalKey(Schema.String).annotate({
    description: "Child model as providerID/modelID. Omit to use the child's configured default.",
  }),
  agent: Schema.optionalKey(Schema.String),
  auto: Schema.optionalKey(Schema.Boolean).annotate({
    description: "The child will execute tools without asking. Explicit per-instance opt-in. Default false.",
  }),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Extra environment variables for the child process only.",
  }),
  allowOutsideRoot: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Permit a cwd outside the driving session's project roots.",
  }),
}).annotate({ identifier: "Headless.StartInput" })

export const StartOutput = Schema.Struct({
  name: Schema.String,
  mode: Mode,
  pid: Schema.Union([Schema.Int, Schema.Null]),
  cwd: Schema.String,
  url: Schema.Union([Schema.String, Schema.Null]),
  sessionID: Schema.Union([Schema.String, Schema.Null]),
}).annotate({ identifier: "Headless.StartOutput" })

export const PromptStatus = Schema.Literals(["idle", "timeout", "error", "exited", "running"] as const)
export type PromptStatus = typeof PromptStatus.Type

export const PromptInput = Schema.Struct({
  name: Name,
  message: Schema.String,
  session: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Default 600000. A timeout returns partial text and leaves the child alive.",
  }),
  wait: Schema.optionalKey(Schema.Boolean).annotate({ description: "Default true. false admits and returns." }),
}).annotate({ identifier: "Headless.PromptInput" })

export const PromptOutput = Schema.Struct({
  sessionID: Schema.String,
  status: PromptStatus,
  text: Schema.String,
  exitCode: Schema.optionalKey(Schema.Int),
  truncated: Schema.Boolean,
}).annotate({ identifier: "Headless.PromptOutput" })

export const EventKind = Schema.Literals(["message", "tool", "permission", "error", "idle"] as const)

export const Event = Schema.Struct({
  type: EventKind,
  at: Schema.Int,
  summary: Schema.String,
}).annotate({ identifier: "Headless.Event" })
export type Event = typeof Event.Type

export const EventsInput = Schema.Struct({
  name: Name,
  session: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Zero-based index to start from. Page with since = since + returned length.",
  }),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500))),
}).annotate({ identifier: "Headless.EventsInput" })

export const EventsOutput = Schema.Array(Event)

export const CaptureInput = Schema.Struct({
  name: Name,
  format: Schema.optionalKey(CaptureFormat),
  tail: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5000))),
}).annotate({ identifier: "Headless.CaptureInput" })

export const CaptureOutput = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  lines: Schema.Int,
}).annotate({ identifier: "Headless.CaptureOutput" })

export const SendInput = Schema.Struct({
  name: Name,
  keys: Schema.optionalKey(Schema.Array(Key)),
  text: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Headless.SendInput" })

export const SendOutput = Schema.Struct({ ok: Schema.Boolean }).annotate({ identifier: "Headless.SendOutput" })

export const WaitInput = Schema.Struct({
  name: Name,
  visible: Schema.optionalKey(Schema.String).annotate({ description: "Substring that must appear in captured text." }),
  idle: Schema.optionalKey(Schema.Boolean).annotate({ description: "Wait until the instance is not busy." }),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "Headless.WaitInput" })

export const WaitOutput = Schema.Struct({
  matched: Schema.Boolean,
  elapsedMs: Schema.Int,
}).annotate({ identifier: "Headless.WaitOutput" })

export const StatusEntry = Schema.Struct({
  name: Schema.String,
  mode: Mode,
  pid: Schema.Union([Schema.Int, Schema.Null]),
  alive: Schema.Boolean,
  cwd: Schema.String,
  busy: Schema.Boolean,
  startedAt: Schema.Int,
  sessionID: Schema.Union([Schema.String, Schema.Null]),
  url: Schema.Union([Schema.String, Schema.Null]),
  tools: Schema.Array(Schema.String),
  version: Schema.String,
}).annotate({ identifier: "Headless.StatusEntry" })

export const StatusInput = Schema.Struct({ name: Schema.optionalKey(Name) }).annotate({
  identifier: "Headless.StatusInput",
})
export const StatusOutput = Schema.Array(StatusEntry)

export const StopInput = Schema.Struct({
  name: Schema.optionalKey(Name).annotate({ description: "Omit to stop every instance owned by this plugin." }),
  force: Schema.optionalKey(Schema.Boolean).annotate({
    description: "SIGKILL after SIGTERM. Default false: SIGTERM only, and report stopped false if it survives.",
  }),
}).annotate({ identifier: "Headless.StopInput" })

export const StopResult = Schema.Struct({
  name: Schema.String,
  stopped: Schema.Boolean,
  exitCode: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Headless.StopResult" })
export const StopOutput = Schema.Array(StopResult)