import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance, parseModel, type InstanceConfig, type PromptRequest } from "./instance.js"
import { capabilities } from "./capabilities.js"
import type { CaptureFormat, Key, Mode } from "./schema.js"

export interface ManagerOptions {
  /** Directories a child cwd may live under without `allowOutsideRoot`. */
  readonly roots: readonly string[]
  /** Nesting depth this manager already sits at. */
  readonly depth: number
  readonly maxDepth: number
  readonly binary?: string
  readonly baseDir?: string
}

export interface StartRequest {
  readonly name: string
  readonly cwd: string
  readonly mode?: Mode
  readonly model?: string
  readonly agent?: string
  readonly auto?: boolean
  readonly env?: Record<string, string>
  readonly allowOutsideRoot?: boolean
}

function inside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Owns every child this plugin started. Isolation is enforced here, not at the call sites: each child gets its own
 * XDG_STATE_HOME so it can never register into the host's service file, and the depth marker makes fork bombs fail.
 */
export class Manager {
  private readonly instances = new Map<string, Instance>()
  private readonly options: ManagerOptions
  private readonly baseDir: string

  constructor(options: ManagerOptions) {
    this.options = options
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), "opencode-headless")
  }

  private scopedCwd(cwd: string, allowOutsideRoot: boolean) {
    if (!path.isAbsolute(cwd)) throw new Error(`cwd must be absolute, got "${cwd}"`)
    const resolved = path.resolve(cwd)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory())
      throw new Error(`cwd does not exist or is not a directory: ${resolved}`)
    if (allowOutsideRoot) return resolved
    if (this.options.roots.some((root) => inside(root, resolved))) return resolved
    throw new Error(
      `cwd ${resolved} is outside this session's roots (${this.options.roots.join(", ")}). Pass allowOutsideRoot: true to allow it.`,
    )
  }

  private environment(request: StartRequest, cwd: string, directory: string) {
    // Caller env first, then the invariants. The model rides in OPENCODE_CONFIG_CONTENT so pty mode can select one
    // too; it merges over the user's config instead of replacing it.
    const merged: Record<string, string | undefined> = {
      ...process.env,
      ...request.env,
      PWD: cwd,
      XDG_STATE_HOME: path.join(directory, "state"),
      OPENCODE_HEADLESS_DEPTH: String(this.options.depth + 1),
      OPENCODE_HEADLESS_NAME: request.name,
    }
    if (request.model === undefined) return merged
    return { ...merged, OPENCODE_CONFIG_CONTENT: configContent(merged.OPENCODE_CONFIG_CONTENT, request.model) }
  }

  async start(request: StartRequest) {
    if (this.instances.has(request.name))
      throw new Error(`An instance named "${request.name}" already exists. Stop it first or pick another name.`)
    if (this.options.depth >= this.options.maxDepth)
      throw new Error(
        `Refusing to start a child at nesting depth ${this.options.depth} (limit ${this.options.maxDepth}). OPENCODE_HEADLESS_DEPTH guards fork bombs.`,
      )
    const cwd = this.scopedCwd(request.cwd, request.allowOutsideRoot === true)
    const directory = path.join(this.baseDir, `${request.name}-${crypto.randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(directory, "state"), { recursive: true })
    const caps = await capabilities(this.options.binary)
    const config: InstanceConfig = {
      name: request.name,
      mode: request.mode ?? "api",
      cwd,
      auto: request.auto === true,
      depth: this.options.depth + 1,
      caps,
      env: this.environment(request, cwd, directory),
      ...(request.model === undefined ? {} : { model: parseModel(request.model) }),
      ...(request.agent === undefined ? {} : { agent: request.agent }),
    }
    const instance = await Instance.start(config).catch((cause) => {
      rmSync(directory, { recursive: true, force: true })
      throw cause
    })
    this.instances.set(request.name, instance)
    this.directories.set(request.name, directory)
    return instance
  }

  private readonly directories = new Map<string, string>()

  get(name: string) {
    const instance = this.instances.get(name)
    if (instance === undefined) throw new Error(`No instance named "${name}". Call headless_status to list them.`)
    return instance
  }

  list() {
    return [...this.instances.values()]
  }

  events(name: string, since: number, limit: number) {
    return this.get(name).eventPage(since, limit)
  }

  capture(name: string, format: CaptureFormat, tail: number) {
    return this.get(name).capture(format, tail)
  }

  send(name: string, keys: readonly Key[], text: string | undefined) {
    return this.get(name).send(keys, text)
  }

  prompt(name: string, request: PromptRequest) {
    return this.get(name).prompt(request)
  }

  wait(name: string, input: { visible?: string; idle?: boolean; timeoutMs: number }) {
    return this.get(name).wait(input)
  }

  status(name?: string) {
    return name === undefined ? this.list().map((instance) => instance.status()) : [this.get(name).status()]
  }

  async stop(name: string | undefined, force: boolean) {
    const targets = name === undefined ? this.list() : [this.get(name)]
    const results = []
    for (const instance of targets) {
      const result = await instance.stop(force)
      results.push(result)
      if (result.stopped) this.forget(instance.name)
    }
    return results
  }

  /** Synchronous last resort for a host process that is already exiting: no awaits, no cleanup beyond the kill. */
  reapSync() {
    for (const instance of this.instances.values()) {
      const pid = instance.pid
      if (pid === undefined) continue
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        continue
      }
    }
    this.instances.clear()
  }

  async dispose() {
    await this.stop(undefined, true)
  }

  private forget(name: string) {
    this.instances.delete(name)
    const directory = this.directories.get(name)
    this.directories.delete(name)
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
}
function configContent(existing: string | undefined, model: string) {
  const base = existing === undefined || existing.trim() === "" ? {} : parseObject(existing)
  return JSON.stringify({ ...base, model })
}

function parseObject(text: string) {
  try {
    const value = JSON.parse(text)
    return typeof value === "object" && value !== null ? value : {}
  } catch {
    return {}
  }
}
