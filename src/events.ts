import type { Event as HeadlessEvent } from "./schema.js"

type Kind = HeadlessEvent["type"]

const SUMMARY_MAX = 200

function oneLine(value: string) {
  const flat = value.replace(/\s+/gu, " ").trim()
  return flat.length > SUMMARY_MAX ? flat.slice(0, SUMMARY_MAX - 1) + "…" : flat
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined
}

export function messageOf(value: unknown): string {
  return text(field(value, "message")) ?? text(value) ?? "unknown error"
}

export interface WireEvent {
  readonly type: string
  readonly created?: number
  readonly data?: unknown
}

export interface EventSink {
  push(event: { type: Kind; at: number; summary: string }): void
  rememberTool(id: string, name: string): void
  toolName(id: string): string | undefined
}

/**
 * Turns one child-server event into at most one normalised event. Raw wire JSON never reaches the model: only the
 * kind, the time, and one bounded human line. `session.tool.input.started` only records the call's name.
 */
export function normalizeWire(event: WireEvent, sink: EventSink) {
  const at = typeof event.created === "number" ? event.created : Date.now()
  const data = event.data
  switch (event.type) {
    case "session.tool.input.started": {
      const id = text(field(data, "id"))
      const name = text(field(data, "name"))
      if (id !== undefined && name !== undefined) sink.rememberTool(id, name)
      return
    }
    case "session.tool.called": {
      const name = sink.toolName(text(field(data, "id")) ?? "") ?? "tool"
      return sink.push({ type: "tool", at, summary: oneLine(`tool ${name}`) })
    }
    case "session.tool.failed": {
      const name = sink.toolName(text(field(data, "id")) ?? "") ?? "tool"
      return sink.push({ type: "error", at, summary: oneLine(`tool ${name} failed: ${messageOf(data)}`) })
    }
    case "session.inbox.delivered":
      return sink.push({ type: "message", at, summary: "prompt delivered" })
    case "permission.asked": {
      const action = text(field(data, "action")) ?? "permission"
      const resources = field(data, "resources")
      const list = Array.isArray(resources) ? resources.filter((item) => typeof item === "string").join(", ") : ""
      return sink.push({ type: "permission", at, summary: oneLine(`${action}${list ? ` (${list})` : ""}`) })
    }
    case "session.execution.succeeded":
      return sink.push({ type: "idle", at, summary: "idle: succeeded" })
    case "session.execution.interrupted": {
      const reason = text(field(data, "reason")) ?? "interrupted"
      return sink.push({ type: "idle", at, summary: oneLine(`idle: interrupted (${reason})`) })
    }
    case "session.execution.failed":
      return sink.push({ type: "error", at, summary: oneLine(`execution failed: ${messageOf(field(data, "error") ?? data)}`) })
    case "session.retry.scheduled": {
      const attempt = field(data, "attempt")
      return sink.push({ type: "error", at, summary: oneLine(`retry ${typeof attempt === "number" ? attempt : "?"}`) })
    }
    default:
      return
  }
}

/** `opencode run --format json` lines are already flat; this maps them onto the same shapes. */
export function normalizeCli(line: string, sink: Pick<EventSink, "push">) {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return
  }
  if (typeof payload !== "object" || payload === null) return
  const type = text(field(payload, "type"))
  const at = typeof field(payload, "timestamp") === "number" ? (field(payload, "timestamp") as number) : Date.now()
  switch (type) {
    case "text": {
      const part = field(payload, "part")
      const content = text(field(part, "text"))
      if (content === undefined) return
      return sink.push({ type: "message", at, summary: oneLine(content) })
    }
    case "tool_use": {
      const part = field(payload, "part")
      const name = text(field(part, "tool")) ?? text(field(part, "name")) ?? "tool"
      return sink.push({ type: "tool", at, summary: oneLine(`tool ${name}`) })
    }
    case "error":
      return sink.push({ type: "error", at, summary: oneLine(messageOf(field(payload, "error") ?? payload)) })
    case "retry": {
      const attempt = field(payload, "attempt")
      return sink.push({ type: "error", at, summary: oneLine(`retry ${typeof attempt === "number" ? attempt : "?"}`) })
    }
    default:
      return
  }
}

/** Assistant text from `opencode run --format json`, used for `headless_prompt`'s `text`. */
export function cliText(lines: readonly string[]) {
  return lines
    .flatMap((line) => {
      try {
        const payload = JSON.parse(line)
        if (typeof payload !== "object" || payload === null) return []
        if (payload.type !== "text") return []
        const content = payload.part?.text
        return typeof content === "string" ? [content] : []
      } catch {
        return []
      }
    })
    .join("\n")
    .trim()
}