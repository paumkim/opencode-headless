import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanup, cwdOf, managerFor, model, scratch } from "./helpers.js"
import { processAlive } from "../src/process.js"

describe("concurrency", () => {
  test("two instances in two cwds stay isolated, and stops are independent", async () => {
    const root = scratch()
    const second = path.join(root, "second")
    mkdirSync(second, { recursive: true })
    const manager = managerFor(root)
    try {
      const a = await manager.start({ name: "a", cwd: cwdOf(root) })
      const b = await manager.start({ name: "b", cwd: second })
      expect(a.pid).not.toBe(b.pid)
      expect(a.status().url).not.toBe(b.status().url)
      expect(a.status().sessionID).not.toBe(b.status().sessionID)
      expect(a.status().cwd).toBe(cwdOf(root))
      expect(b.status().cwd).toBe(second)
      expect(manager.events("a", 0, 10)).toEqual([])
      expect(manager.events("b", 0, 10)).toEqual([])

      const [stopped] = await manager.stop("a", true)
      expect(stopped?.stopped).toBe(true)
      expect(processAlive(a.pid!)).toBe(false)
      expect(processAlive(b.pid!)).toBe(true)
      expect(manager.status()).toHaveLength(1)
    } finally {
      await cleanup(manager, root)
    }
  })

  const integration = test.skipIf(model === undefined)
  integration(
    "concurrent prompts write only to their own cwd",
    async () => {
      const root = scratch()
      const second = path.join(root, "second")
      mkdirSync(second, { recursive: true })
      const manager = managerFor(root)
      const word = (directory: string, value: string) => {
        writeFileSync(path.join(directory, "seed.txt"), value)
      }
      try {
        word(cwdOf(root), "alpha")
        word(second, "beta")
        await Promise.all([
          manager.start({ name: "one", cwd: cwdOf(root), model }),
          manager.start({ name: "two", cwd: second, model }),
        ])
        const [first, other] = await Promise.all([
          manager.prompt("one", {
            message: "Read seed.txt with the read tool and reply with its exact contents.",
            timeoutMs: 180_000,
            wait: true,
          }),
          manager.prompt("two", {
            message: "Read seed.txt with the read tool and reply with its exact contents.",
            timeoutMs: 180_000,
            wait: true,
          }),
        ])
        expect(first.status).toBe("idle")
        expect(other.status).toBe("idle")
        expect(first.text).toContain("alpha")
        expect(first.text).not.toContain("beta")
        expect(other.text).toContain("beta")
        expect(other.text).not.toContain("alpha")
        expect(existsSync(path.join(second, "hello.txt"))).toBe(false)
      } finally {
        await cleanup(manager, root)
      }
    },
    { timeout: 240_000 },
  )
})