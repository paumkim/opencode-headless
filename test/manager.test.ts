import { describe, expect, test } from "bun:test"
import path from "node:path"
import { cleanup, cwdOf, managerFor, scratch } from "./helpers.js"

describe("manager guardrails", () => {
  test("rejects a relative cwd", async () => {
    const manager = managerFor(scratch())
    await expect(manager.start({ name: "relative", cwd: "work" })).rejects.toThrow(/must be absolute/u)
    await manager.dispose()
  })

  test("rejects a cwd that does not exist", async () => {
    const root = scratch()
    const manager = managerFor(root)
    await expect(manager.start({ name: "missing", cwd: path.join(root, "nope") })).rejects.toThrow(
      /does not exist/u,
    )
    await manager.dispose()
  })

  test("rejects a cwd outside the session roots unless allowed", async () => {
    const root = scratch()
    const manager = managerFor(root)
    await expect(manager.start({ name: "outside", cwd: "/tmp" })).rejects.toThrow(/outside this session's roots/u)
    await manager.dispose()
  })

  test("stops a child at the nesting limit before spawning", async () => {
    const root = scratch()
    const manager = managerFor(root, { depth: 1, maxDepth: 1 })
    await expect(manager.start({ name: "deep", cwd: cwdOf(root) })).rejects.toThrow(/nesting depth 1/u)
    await manager.dispose()
  })

  test("a duplicate name is an error, not a silent replace", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const first = await manager.start({ name: "dupe", cwd: cwdOf(root) })
      await expect(manager.start({ name: "dupe", cwd: cwdOf(root) })).rejects.toThrow(/already exists/u)
      expect(manager.status("dupe")).toHaveLength(1)
      await manager.stop("dupe", true)
      expect(manager.status()).toEqual([])
      // The name is reusable once the instance is gone.
      const second = await manager.start({ name: "dupe", cwd: cwdOf(root) })
      expect(second.pid).not.toBe(first.pid)
    } finally {
      await cleanup(manager, root)
    }
  }, 60_000)

  test("status and events are pure reads, and unknown names fail loudly", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "read", cwd: cwdOf(root) })
      expect(instance.status().mode).toBe("api")
      expect(manager.events("read", 0, 10)).toEqual([])
      expect(() => manager.status("nope")).toThrow(/No instance named/u)
    } finally {
      await cleanup(manager, root)
    }
  })

  test("capture ansi is refused outside pty without killing the child", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "capture", cwd: cwdOf(root) })
      expect(() => manager.capture("capture", "ansi", 10)).toThrow(/only available in pty mode/u)
      expect(instance.alive).toBe(true)
      expect(() => manager.send("capture", ["enter"], undefined)).toThrow(/only available in pty mode/u)
    } finally {
      await cleanup(manager, root)
    }
  })
})