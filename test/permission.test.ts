import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  cleanup,
  cwdOf,
  managerFor,
  model,
  permissionConfig,
  scratch,
} from "./helpers.js"

const integration = test.skipIf(model === undefined)

// Without `auto`, a permission request stalls the child by design. That is the deterministic "never finishes" prompt:
// no model timing luck involved.
describe("prompt timeout and permission stalls", () => {
  integration(
    "reports timeout with partial text, a permission event, and keeps the child alive",
    async () => {
      const root = scratch()
      const manager = managerFor(root)
      const work = cwdOf(root)
      const config = permissionConfig(root)
      try {
        const instance = await manager.start({
          name: "stall",
          cwd: work,
          model,
          env: { XDG_CONFIG_HOME: config },
        })
        const pid = instance.pid!
        const result = await manager.prompt("stall", {
          message: "Use the shell tool to run exactly: touch marker.txt",
          timeoutMs: 30_000,
          wait: true,
        })
        expect(result.status).toBe("timeout")
        expect(instance.alive).toBe(true)
        expect(existsSync(path.join(work, "marker.txt"))).toBe(false)
        const events = manager.events("stall", 0, 100)
        expect(events.some((event) => event.type === "permission")).toBe(true)
        const [stopped] = await manager.stop("stall", true)
        expect(stopped?.stopped).toBe(true)
      } finally {
        await cleanup(manager, root)
      }
    },
    { timeout: 120_000 },
  )

  integration(
    "auto: true is an explicit opt-in that approves the same request",
    async () => {
      const root = scratch()
      const manager = managerFor(root)
      const work = cwdOf(root)
      const config = permissionConfig(root)
      try {
        await manager.start({ name: "auto", cwd: work, model, env: { XDG_CONFIG_HOME: config }, auto: true })
        const result = await manager.prompt("auto", {
          message: "Use the shell tool to run exactly: touch marker.txt",
          timeoutMs: 180_000,
          wait: true,
        })
        expect(result.status).toBe("idle")
        expect(existsSync(path.join(work, "marker.txt"))).toBe(true)
        expect(manager.events("auto", 0, 100).some((event) => event.type === "permission")).toBe(true)
      } finally {
        await cleanup(manager, root)
      }
    },
    { timeout: 200_000 },
  )
})