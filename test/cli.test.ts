import { describe, expect, test } from "bun:test"
import { cleanup, cwdOf, managerFor, model, scratch } from "./helpers.js"
import { processAlive } from "../src/process.js"

const integration = test.skipIf(model === undefined)

describe("cli transport", () => {
  integration(
    "runs one opencode run per prompt and reads its json events",
    async () => {
      const root = scratch()
      const manager = managerFor(root)
      try {
        const instance = await manager.start({ name: "cli", cwd: cwdOf(root), mode: "cli", model })
        // cli has no long-lived process, so the pid is null between prompts.
        expect(instance.pid).toBeUndefined()
        const result = await manager.prompt("cli", {
          message: "Reply with the single word READY and nothing else.",
          timeoutMs: 180_000,
          wait: true,
        })
        expect(result.status).toBe("idle")
        expect(result.exitCode).toBe(0)
        expect(result.text).toContain("READY")
        expect(result.sessionID).toStartWith("ses_")

        const events = manager.events("cli", 0, 100)
        expect(events.some((event) => event.type === "message")).toBe(true)
        expect(manager.capture("cli", "text", 20).text).toContain("\"type\":\"step_start\"")

        const [stopped] = await manager.stop("cli", true)
        expect(stopped?.stopped).toBe(true)
      } finally {
        await cleanup(manager, root)
      }
    },
    { timeout: 200_000 },
  )

  test("a cli instance can be started and stopped without a model", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      await manager.start({ name: "idle", cwd: cwdOf(root), mode: "cli" })
      expect(manager.status("idle")[0]?.alive).toBe(false)
      const [stopped] = await manager.stop("idle", true)
      expect(stopped?.stopped).toBe(true)
      expect(manager.status()).toEqual([])
    } finally {
      await cleanup(manager, root)
    }
  })

  test("capture still refuses ansi in cli mode", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      await manager.start({ name: "cli-ansi", cwd: cwdOf(root), mode: "cli" })
      expect(() => manager.capture("cli-ansi", "ansi", 5)).toThrow(/only available in pty mode/u)
    } finally {
      await cleanup(manager, root)
    }
  })
})

// Kept out of CI: a TUI needs a real terminal and is slow. Set OPENCODE_HEADLESS_TEST_PTY=1 locally.
const pty = test.skipIf(process.env.OPENCODE_HEADLESS_TEST_PTY !== "1")
pty(
  "pty captures the TUI and accepts keys",
  async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "tui", cwd: cwdOf(root), mode: "pty", model })
      expect(instance.alive).toBe(true)
      const ansi = manager.capture("tui", "ansi", 20)
      expect(ansi.lines).toBeGreaterThan(0)
      expect(manager.capture("tui", "text", 20).text.length).toBeGreaterThan(0)
      manager.send("tui", ["enter"], "hello")
      const [stopped] = await manager.stop("tui", true)
      expect(stopped?.stopped).toBe(true)
      expect(processAlive(instance.pid!)).toBe(false)
    } finally {
      await cleanup(manager, root)
    }
  },
  { timeout: 120_000 },
)