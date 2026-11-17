import { describe, expect, test } from "bun:test"
import { cliText, normalizeCli, normalizeWire, type EventSink } from "../src/events.js"
import type { Event } from "../src/schema.js"

function sink() {
  const events: Event[] = []
  const names = new Map<string, string>()
  const value: EventSink = {
    push: (event) => events.push(event),
    rememberTool: (id, name) => names.set(id, name),
    toolName: (id) => names.get(id),
  }
  return { events, names, value }
}

describe("wire event normalisation", () => {
  test("a tool call uses the name learned from input.started", () => {
    const { events, value } = sink()
    normalizeWire({ type: "session.tool.input.started", created: 1, data: { id: "call-1", name: "shell" } }, value)
    normalizeWire({ type: "session.tool.called", created: 2, data: { id: "call-1", executed: true } }, value)
    expect(events).toEqual([{ type: "tool", at: 2, summary: "tool shell" }])
  })

  test("a permission request is one bounded line with its action and resources", () => {
    const { events, value } = sink()
    normalizeWire(
      { type: "permission.asked", created: 3, data: { action: "shell", resources: ["rm -rf /tmp/x"] } },
      value,
    )
    expect(events).toEqual([{ type: "permission", at: 3, summary: "shell (rm -rf /tmp/x)" }])
  })

  test("terminal events map to idle and error", () => {
    const { events, value } = sink()
    normalizeWire({ type: "session.execution.succeeded", created: 4, data: { sessionID: "ses_1" } }, value)
    normalizeWire(
      { type: "session.execution.failed", created: 5, data: { sessionID: "ses_1", error: { message: "boom" } } },
      value,
    )
    normalizeWire(
      { type: "session.execution.interrupted", created: 6, data: { sessionID: "ses_1", reason: "user" } },
      value,
    )
    expect(events).toEqual([
      { type: "idle", at: 4, summary: "idle: succeeded" },
      { type: "error", at: 5, summary: "execution failed: boom" },
      { type: "idle", at: 6, summary: "idle: interrupted (user)" },
    ])
  })

  test("unknown and noisy events are dropped", () => {
    const { events, value } = sink()
    normalizeWire({ type: "session.step.started", created: 7, data: {} }, value)
    normalizeWire({ type: "server.connected", created: 8, data: {} }, value)
    expect(events).toEqual([])
  })

  test("summaries are flattened and capped", () => {
    const { events, value } = sink()
    normalizeWire({ type: "permission.asked", created: 9, data: { action: "x", resources: ["a\nb".repeat(200)] } }, value)
    expect(events[0]!.summary.includes("\n")).toBe(false)
    expect(events[0]!.summary.length).toBeLessThanOrEqual(200)
  })
})

describe("cli json normalisation", () => {
  test("maps text, tool_use and error lines", () => {
    const { events, value } = sink()
    normalizeCli(JSON.stringify({ type: "text", timestamp: 1, part: { type: "text", text: "hello" } }), value)
    normalizeCli(JSON.stringify({ type: "tool_use", timestamp: 2, part: { tool: "shell" } }), value)
    normalizeCli(JSON.stringify({ type: "error", timestamp: 3, error: { message: "nope" } }), value)
    expect(events).toEqual([
      { type: "message", at: 1, summary: "hello" },
      { type: "tool", at: 2, summary: "tool shell" },
      { type: "error", at: 3, summary: "nope" },
    ])
  })

  test("ignores lines that are not json", () => {
    const { events, value } = sink()
    normalizeCli("not json", value)
    expect(events).toEqual([])
  })

  test("cliText joins assistant text only", () => {
    const lines = [
      JSON.stringify({ type: "text", part: { text: "one" } }),
      JSON.stringify({ type: "tool_use", part: { tool: "shell" } }),
      JSON.stringify({ type: "text", part: { text: "two" } }),
      "garbage",
    ]
    expect(cliText(lines)).toBe("one\ntwo")
  })
})