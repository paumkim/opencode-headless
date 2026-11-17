import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { cleanup, cwdOf, fingerprint, hostServiceFile, managerFor, model, scratch } from "./helpers.js"
import { processAlive } from "../src/process.js"

const integration = test.skipIf(model === undefined)

describe("headless_prompt on a real child", () => {
  integration(
    "prompt creates a file in the child cwd, returns idle, and reaps cleanly",
    async () => {
      const root = scratch()
      const manager = managerFor(root)
      const work = cwdOf(root)
      const before = fingerprint(hostServiceFile())
      try {
        const instance = await manager.start({ name: "work", cwd: work, model })
        const pid = instance.pid!
        const result = await manager.prompt("work", {
          message:
            "Create a file named hello.txt in the current directory containing exactly: headless works. Then reply with the single word DONE.",
          timeoutMs: 180_000,
          wait: true,
        })
        expect(result.status).toBe("idle")
        expect(result.sessionID).toStartWith("ses_")
        expect(result.text.length).toBeGreaterThan(0)
        expect(readFileSync(path.join(work, "hello.txt"), "utf8")).toContain("headless works")
        expect(manager.status("work")[0]?.busy).toBe(false)
        expect(manager.status("work")[0]?.tools.length).toBeGreaterThan(0)

        await manager.stop("work", true)
        expect(processAlive(pid)).toBe(false)
      } finally {
        await cleanup(manager, root)
      }
      expect(fingerprint(hostServiceFile())).toBe(before)
    },
    { timeout: 200_000 },
  )
})