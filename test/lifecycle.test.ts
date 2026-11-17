import { describe, expect, test } from "bun:test"
import { cleanup, cwdOf, fingerprint, hostServiceFile, managerFor, scratch } from "./helpers.js"
import { processAlive } from "../src/process.js"

describe("lifecycle and host isolation", () => {
  test("start, inspect, stop leaves no orphan and never touches the host service file", async () => {
    const root = scratch()
    const manager = managerFor(root)
    const before = fingerprint(hostServiceFile())
    try {
      const instance = await manager.start({ name: "life", cwd: cwdOf(root) })
      const pid = instance.pid!
      expect(instance.alive).toBe(true)
      expect(processAlive(pid)).toBe(true)
      // The child reports its own endpoint and session; both prove it is a private server, not the host daemon.
      expect(instance.status().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(instance.status().sessionID).toStartWith("ses_")

      const capture = manager.capture("life", "text", 50)
      expect(capture.text.length).toBeGreaterThan(0)
      expect(capture.text.includes("\u001b")).toBe(false)

      const stopped = await manager.stop("life", true)
      expect(stopped[0]?.stopped).toBe(true)
      expect(processAlive(pid)).toBe(false)
      expect(manager.status()).toEqual([])
    } finally {
      await cleanup(manager, root)
    }
    expect(fingerprint(hostServiceFile())).toBe(before)
  }, 60_000)

  test("plugin unload reaps a running instance", async () => {
    const root = scratch()
    const manager = managerFor(root)
    const before = fingerprint(hostServiceFile())
    try {
      const instance = await manager.start({ name: "unload", cwd: cwdOf(root) })
      const pid = instance.pid!
      expect(processAlive(pid)).toBe(true)
      await manager.dispose()
      expect(processAlive(pid)).toBe(false)
      expect(manager.status()).toEqual([])
    } finally {
      await cleanup(manager, root)
    }
    expect(fingerprint(hostServiceFile())).toBe(before)
  }, 60_000)

  test("reapSync kills without awaiting", async () => {
    const root = scratch()
    const manager = managerFor(root)
    try {
      const instance = await manager.start({ name: "sync", cwd: cwdOf(root) })
      const pid = instance.pid!
      manager.reapSync()
      await Bun.sleep(200)
      expect(processAlive(pid)).toBe(false)
    } finally {
      await cleanup(manager, root)
    }
  }, 60_000)
})