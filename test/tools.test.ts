import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { headlessTools } from "../src/tools.js"
import { StartInput } from "../src/schema.js"
import { Manager } from "../src/manager.js"
import os from "node:os"
import path from "node:path"

const expected = [
  "headless_start",
  "headless_prompt",
  "headless_events",
  "headless_capture",
  "headless_send",
  "headless_wait",
  "headless_status",
  "headless_stop",
]

const manager = new Manager({
  roots: [os.tmpdir()],
  depth: 0,
  maxDepth: 3,
  baseDir: path.join(os.tmpdir(), "headless-tools-test"),
})

describe("tool surface", () => {
  test("registers every tool with a schema and no codemode", () => {
    const tools = headlessTools(manager)
    expect(tools.map((tool) => tool.name)).toEqual(expected)
    for (const tool of tools) {
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.input).toBeDefined()
      expect(tool.output).toBeDefined()
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  test("headless_start rejects a name that is not lowercase-hyphenated", () => {
    const decode = Schema.decodeUnknownOption(StartInput)
    expect(decode({ name: "Bad Name", cwd: "/tmp" })._tag).toBe("None")
    expect(decode({ name: "good-name", cwd: "/tmp" })._tag).toBe("Some")
  })

  test("every tool's input schema decodes a minimal valid call", () => {
    const minimal: Record<string, unknown> = {
      headless_start: { name: "a", cwd: "/tmp" },
      headless_prompt: { name: "a", message: "hi" },
      headless_events: { name: "a" },
      headless_capture: { name: "a" },
      headless_send: { name: "a" },
      headless_wait: { name: "a", visible: "x" },
      headless_status: {},
      headless_stop: {},
    }
    for (const tool of headlessTools(manager)) {
      const decode = Schema.decodeUnknownOption(tool.input as never)
      expect(decode(minimal[tool.name] as never)._tag).toBe("Some")
    }
  })
})