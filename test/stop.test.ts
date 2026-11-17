import { describe, expect, test } from "bun:test"
import { cleanup, cwdOf, managerFor, scratch } from "./helpers.js"
import { processAlive } from "../src/process.js"

describe("headless_stop", () => {
  test("SIGTERM stops a normal child", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "term", cwd: cwdOf(root) })
      const pid = instance.pid!
      const [result] = await manager.stop("term", false)
      expect(result?.stopped).toBe(true)
      expect(result?.exitCode).toBeDefined()
      expect(processAlive(pid)).toBe(false)
    } finally {
      await cleanup(manager, root)
    }
  })

  test("a SIGSTOPped child survives force:false and is SIGKILLed by force:true", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "stubborn", cwd: cwdOf(root) })
      const pid = instance.pid!
      process.kill(pid, "SIGSTOP")

      const [soft] = await manager.stop("stubborn", false)
      expect(soft?.stopped).toBe(false)
      expect(processAlive(pid)).toBe(true)
      // Still registered, so it can be retried.
      expect(manager.status("stubborn")).toHaveLength(1)

      const [hard] = await manager.stop("stubborn", true)
      expect(hard?.stopped).toBe(true)
      expect(processAlive(pid)).toBe(false)
      expect(manager.status()).toEqual([])
    } finally {
      await cleanup(manager, root)
    }
  }, 60_000)

  test("stop with no name stops every owned instance", async () => {
    const root = scratch()
    const other = scratch()
    const manager = managerFor(root)
    try {
      const a = await manager.start({ name: "a", cwd: cwdOf(root) })
      const b = await manager.start({ name: "b", cwd: cwdOf(other), allowOutsideRoot: true })
      const results = await manager.stop(undefined, true)
      expect(results.map((result) => result.name).sort()).toEqual(["a", "b"])
      expect(results.every((result) => result.stopped)).toBe(true)
      expect(processAlive(a.pid!)).toBe(false)
      expect(processAlive(b.pid!)).toBe(false)
    } finally {
      await cleanup(manager, root)
      await cleanup(manager, other)
    }
  }, 60_000)
})