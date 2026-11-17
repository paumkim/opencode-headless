import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Manager } from "../src/manager.js"

/** Integration tests need a provider the host is signed in to. Skipped when absent, never mocked. */
export const model = process.env.OPENCODE_HEADLESS_TEST_MODEL

export function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "headless-test-"))
  mkdirSync(path.join(root, "work"), { recursive: true })
  return root
}

export function managerFor(root: string, options: { depth?: number; maxDepth?: number } = {}) {
  return new Manager({
    roots: [root],
    depth: options.depth ?? 0,
    maxDepth: options.maxDepth ?? 3,
    baseDir: path.join(root, "instances"),
  })
}

export function cwdOf(root: string) {
  return path.join(root, "work")
}

export function hostServiceFile() {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "service.json")
}

/** Byte-exact fingerprint; "missing" keeps the before/after comparison honest on a host with no service. */
export function fingerprint(file: string) {
  if (!existsSync(file)) return "missing"
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export async function cleanup(manager: Manager, root: string) {
  await manager.dispose().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

export function permissionConfig(root: string) {
  const directory = path.join(root, "config")
  mkdirSync(path.join(directory, "opencode"), { recursive: true })
  writeFileSync(
    path.join(directory, "opencode", "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agents: { build: { permissions: [{ action: "shell", resource: "*", effect: "ask" }] } },
    }),
  )
  return directory
}