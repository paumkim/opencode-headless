import { describe, expect, test } from "bun:test"
import { capabilities, runArgv, serveArgv, tuiArgv } from "../src/capabilities.js"

describe("inheriting the installed harness", () => {
  test("probes the real binary instead of assuming a version", async () => {
    const caps = await capabilities()
    expect(caps.binary.length).toBeGreaterThan(0)
    expect(caps.version).toMatch(/v?\d+\.\d+/u)
    expect(caps.subcommands.has("serve")).toBe(true)
    expect(caps.subcommands.has("run")).toBe(true)
    // These are the flags the plugin relies on; a future harness that drops one is detected, not crashed on.
    expect(caps.flags.has("standalone")).toBe(true)
    expect(caps.flags.has("format")).toBe(true)
    expect(caps.flags.has("auto")).toBe(true)
  })

  test("builds argv only from advertised flags", async () => {
    const caps = await capabilities()
    expect(serveArgv(caps)[1]).toBe("serve")
    const run = runArgv(caps, { message: "hi", auto: true })
    expect(run.argv[1]).toBe("run")
    expect(run.argv).toContain("--format")
    expect(run.argv).toContain("json")
    expect(run.json).toBe(true)
    expect(tuiArgv(caps, { cwd: "/tmp", auto: true }).at(-1)).toBe("/tmp")
  })

  test("refuses a harness without the subcommand it needs", async () => {
    const caps = await capabilities()
    expect(() => serveArgv({ ...caps, subcommands: new Set() })).toThrow(/no "serve" subcommand/u)
    expect(() => runArgv({ ...caps, subcommands: new Set() }, { message: "hi", auto: false })).toThrow(
      /no "run" subcommand/u,
    )
  })
})