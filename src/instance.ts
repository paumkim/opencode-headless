import { Api, ApiError, messageText } from "./api.js"
import {
  runArgv,
  serveArgv,
  tuiArgv,
  type BinaryCapabilities,
} from "./capabilities.js"
import { cliText, messageOf, normalizeCli, normalizeWire } from "./events.js"
import { OutputBuffer, containsVisible, tailText } from "./output.js"
import {
  parseEndpoint,
  processAlive,
  signal,
  spawnProcess,
  waitForExit,
  waitUntil,
  type ServerEndpoint,
} from "./process.js"
import type { CaptureFormat, Event, Key, Mode, PromptStatus } from "./schema.js"

const MAX_EVENTS = 1_000
const MAX_TOOL_NAMES = 50
const PTY_QUIET_MS = 1_500
const API_START_TIMEOUT_MS = 20_000

export interface InstanceConfig {
  readonly name: string
  readonly mode: Mode
  readonly cwd: string
  readonly auto: boolean
  readonly depth: number
  readonly caps: BinaryCapabilities
  readonly env: Record<string, string | undefined>
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly agent?: string
}

export interface PromptRequest {
  readonly message: string
  readonly session?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly timeoutMs: number
  readonly wait: boolean
}

export interface PromptResult {
  readonly sessionID: string
  readonly status: PromptStatus
  readonly text: string
  readonly exitCode?: number
  readonly truncated: boolean
}

export interface CaptureResult {
  readonly text: string
  readonly truncated: boolean
  readonly lines: number
}

interface ApiState {
  readonly api: Api
  readonly endpoint: ServerEndpoint
  readonly controller: AbortController
}

const keyBytes: Record<Key, string> = {
  enter: "\r",
  escape: "\u001b",
  "ctrl-c": "\u0003",
  up: "\u001b[A",
  down: "\u001b[B",
  tab: "\t",
  y: "y",
  n: "n",
}

function parseModel(value: string) {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Model "${value}" must be providerID/modelID`)
  return { providerID: value.slice(0, separator), id: value.slice(separator + 1) }
}

/** One driven child. Mode-specific behaviour is branched here so every instance shares the same event log and stop path. */
export class Instance {
  readonly name: string
  readonly mode: Mode
  readonly cwd: string
  readonly startedAt = Date.now()
  readonly auto: boolean
  readonly depth: number
  readonly version: string
  private readonly config: InstanceConfig
  private output: OutputBuffer
  private proc: Bun.Subprocess | undefined
  private api: ApiState | undefined
  private sessionID: string | undefined
  private busy = false
  private lastDataAt = Date.now()
  private exitCode: number | undefined
  private readonly terminalCounts = new Map<string, number>()
  private readonly terminalOutcomes = new Map<string, PromptStatus>()
  private readonly events: Event[] = []
  private readonly toolNames = new Map<string, string>()
  private readonly toolList: string[] = []
  private readonly notifyListeners = new Set<() => void>()

  private constructor(config: InstanceConfig) {
    this.config = config
    this.name = config.name
    this.mode = config.mode
    this.cwd = config.cwd
    this.auto = config.auto
    this.depth = config.depth
    this.version = config.caps.version
    this.output = new OutputBuffer({ ansi: config.mode === "pty" })
  }

  static async start(config: InstanceConfig) {
    const instance = new Instance(config)
    await instance.boot()
    return instance
  }

  private async boot() {
    if (this.mode === "cli") return
    if (this.mode === "pty") return this.bootPty()
    return this.bootApi()
  }

  private watchExit(proc: Bun.Subprocess) {
    void proc.exited.then((code) => {
      this.exitCode = code
      this.busy = false
      this.notify()
    })
  }

  private attach(output: OutputBuffer) {
    this.output = output
    output.subscribe(() => {
      this.lastDataAt = Date.now()
      this.notify()
    })
  }

  private async bootApi() {
    const spawned = spawnProcess({
      argv: serveArgv(this.config.caps),
      cwd: this.cwd,
      env: this.config.env,
      ansi: false,
    })
    this.proc = spawned.proc
    this.attach(spawned.output)
    this.watchExit(spawned.proc)
    const endpoint = await waitUntil(
      () => {
        const parsed = parseEndpoint(spawned.output.text())
        return parsed.url !== undefined && parsed.password !== undefined
          ? { url: parsed.url, password: parsed.password }
          : undefined
      },
      API_START_TIMEOUT_MS,
      (listener) => spawned.output.subscribe(listener),
      () => new Error(`Child "${this.name}" did not report its server endpoint in ${API_START_TIMEOUT_MS}ms`),
    ).catch((cause) => {
      this.kill()
      throw cause
    })
    // The API prefix and route shapes come from the child itself, not from a pinned client build.
    const api = await Api.connect(endpoint.url, endpoint.password).catch((cause) => {
      this.kill()
      throw cause
    })
    const controller = new AbortController()
    this.api = { api, endpoint, controller }
    void this.consume(api, controller)
    const sessionID = await api.createSession(this.cwd).catch((cause) => {
      this.kill()
      throw cause
    })
    this.sessionID = sessionID
  }

  private async bootPty() {
    if (process.platform === "win32") throw new Error("pty mode needs a POSIX pseudo-terminal; use api or cli on Windows")
    const spawned = spawnProcess({
      argv: tuiArgv(this.config.caps, { cwd: this.cwd, auto: this.auto }),
      cwd: this.cwd,
      env: this.config.env,
      ansi: true,
      terminal: { cols: 120, rows: 40 },
    })
    this.proc = spawned.proc
    this.attach(spawned.output)
    this.watchExit(spawned.proc)
    // The first frame proves the TUI started; anything else means the child failed to boot.
    await waitUntil(
      () => (spawned.output.text().length > 0 ? true : undefined),
      15_000,
      (listener) => spawned.output.subscribe(listener),
      () => new Error(`Child "${this.name}" produced no TUI output in 15000ms`),
    ).catch((cause) => {
      this.kill()
      throw cause
    })
    // The composer swallows input until the first full frame is painted; wait for the footer hint.
    await waitUntil(
      () => (containsVisible(spawned.output.text(), "ctrl+p") ? true : undefined),
      15_000,
      (listener) => spawned.output.subscribe(listener),
      () => new Error("footer"),
    ).catch(() => false)
    // The footer paints before the composer takes focus; a short settle keeps the first prompt from being dropped.
    await Bun.sleep(800)
  }

  /** Persistent event stream. It owns permissions for this child when `auto` is on, and wakes every waiter. */
  private async consume(api: Api, controller: AbortController) {
    const iterator = api.events(controller.signal)
    while (!controller.signal.aborted) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }))
      if (next.done || next.value === undefined) return
      const event = next.value
      normalizeWire({ type: event.type, created: event.created, data: event.data }, this)
      const data = event.data as { sessionID?: string; id?: string } | undefined
      if (event.type === "permission.asked" && this.auto && data !== undefined) {
        if (data.sessionID !== undefined && data.id !== undefined)
          void api.replyPermission(data.sessionID, data.id, "once").catch(() => {})
      }
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        if (data?.sessionID !== undefined) {
          this.terminalCounts.set(data.sessionID, (this.terminalCounts.get(data.sessionID) ?? 0) + 1)
          this.terminalOutcomes.set(data.sessionID, event.type === "session.execution.succeeded" ? "idle" : "error")
          if (data.sessionID === this.sessionID) this.busy = false
        }
      }
      this.notify()
    }
  }

  push(event: Event) {
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.notify()
  }

  rememberTool(id: string, name: string) {
    this.toolNames.set(id, name)
    if (!this.toolList.includes(name)) this.toolList.push(name)
    if (this.toolList.length > MAX_TOOL_NAMES) this.toolList.splice(0, this.toolList.length - MAX_TOOL_NAMES)
  }

  toolName(id: string) {
    return this.toolNames.get(id)
  }

  private notify() {
    this.notifyListeners.forEach((listener) => listener())
  }

  private onNotify(listener: () => void) {
    this.notifyListeners.add(listener)
    return () => this.notifyListeners.delete(listener)
  }

  private kill() {
    if (this.proc === undefined) return
    signal(this.proc.pid, "SIGTERM")
  }

  get pid() {
    return this.proc?.pid
  }

  get url() {
    return this.api?.endpoint.url ?? null
  }

  get alive() {
    return this.proc !== undefined && this.exitCode === undefined && processAlive(this.proc.pid)
  }

  get currentSession() {
    return this.sessionID ?? null
  }

  get isBusy() {
    return this.busy
  }

  get tools() {
    return [...this.toolList]
  }

  eventPage(since: number, limit: number) {
    return this.events.slice(since, since + limit)
  }

  eventCount() {
    return this.events.length
  }

  capture(format: CaptureFormat, tail: number): CaptureResult {
    if (format === "ansi" && this.mode !== "pty")
      throw new Error(`capture format "ansi" is only available in pty mode (this instance is ${this.mode})`)
    const raw = format === "ansi" ? this.output.ansiText() : this.output.text()
    const result = tailText(raw, tail)
    const text = format === "json" ? JSON.stringify(result.text.split("\n")) : result.text
    return { text, truncated: result.truncated, lines: result.lines }
  }

  /** Assistant prose plus the tool names that ran, read from the child's own message log. */
  private async apiText(api: Api, sessionID: string) {
    const messages = await api.messages(sessionID).catch((cause) => {
      throw new ApiError(`could not read messages: ${messageOf(cause)}`)
    })
    return messageText(messages)
  }

  async prompt(request: PromptRequest): Promise<PromptResult> {
    if (this.mode === "cli") return this.promptCli(request)
    if (this.mode === "pty") return this.promptPty(request)
    return this.promptApi(request)
  }

  private async promptApi(request: PromptRequest): Promise<PromptResult> {
    const state = this.api
    if (state === undefined) throw new Error(`Child "${this.name}" has no API state; it may have exited`)
    const sessionID = request.session ?? this.sessionID
    if (sessionID === undefined) throw new Error(`Child "${this.name}" has no session`)
    if (request.agent !== undefined) {
      await state.api.switchAgent(sessionID, request.agent).catch((cause) => {
        throw new Error(`could not select agent "${request.agent}": ${messageOf(cause)}`)
      })
    }
    const model = request.model ?? this.config.model
    if (model !== undefined) {
      await state.api.switchModel(sessionID, model).catch((cause) => {
        throw new Error(`could not select model "${model.providerID}/${model.id}": ${messageOf(cause)}`)
      })
    }
    const baseline = this.terminalCounts.get(sessionID) ?? 0
    this.sessionID = sessionID
    this.busy = true
    await state.api.prompt(sessionID, request.message).catch((cause) => {
      this.busy = false
      throw new Error(`prompt was not admitted: ${messageOf(cause)}`)
    })
    if (!request.wait) return { sessionID, status: "running", text: "", truncated: false }
    const outcome = await waitUntil(
      () => {
        if ((this.terminalCounts.get(sessionID) ?? 0) > baseline) return "terminal" as const
        if (this.exitCode !== undefined) return "exited" as const
        return undefined
      },
      request.timeoutMs,
      (listener) => this.onNotify(listener),
      () => new Error("timeout"),
    ).catch(() => undefined)
    const bounded = tailText(await this.apiText(state.api, sessionID).catch((cause) => messageOf(cause)))
    if (outcome === "exited")
      return { sessionID, status: "exited", text: bounded.text, truncated: bounded.truncated, exitCode: this.exitCode }
    if (outcome === undefined) return { sessionID, status: "timeout", text: bounded.text, truncated: bounded.truncated }
    return { sessionID, status: this.terminalOutcomes.get(sessionID) ?? "idle", text: bounded.text, truncated: bounded.truncated }
  }

  private async promptCli(request: PromptRequest): Promise<PromptResult> {
    if (this.busy) throw new Error(`Child "${this.name}" is already running a prompt`)
    const sessionID = request.session ?? this.sessionID
    const model = request.model ?? this.config.model
    const agent = request.agent ?? this.config.agent
    this.sessionID = sessionID
    const built = runArgv(this.config.caps, {
      message: request.message,
      auto: this.auto,
      ...(sessionID === undefined ? {} : { session: sessionID }),
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model: `${model.providerID}/${model.id}` }),
    })
    const spawned = spawnProcess({ argv: built.argv, cwd: this.cwd, env: this.config.env, ansi: false })
    this.attach(spawned.output)
    spawned.output.onLine((line) => normalizeCli(line, this))
    this.proc = spawned.proc
    this.watchExit(spawned.proc)
    this.busy = true
    if (!request.wait) return { sessionID: sessionID ?? "", status: "running", text: "", truncated: false }
    const code = await waitForExit(spawned.proc, request.timeoutMs)
    const raw = spawned.output.text()
    const text = built.json ? cliText(raw.split("\n")) : raw
    const bounded = tailText(text)
    const resultSession = this.discoverSession(raw) ?? sessionID ?? ""
    if (code === undefined)
      return {
        sessionID: resultSession,
        status: "timeout",
        text: bounded.text,
        truncated: bounded.truncated,
        exitCode: this.exitCode,
      }
    this.busy = false
    this.proc = undefined
    return {
      sessionID: resultSession,
      status: code === 0 ? "idle" : "error",
      text: bounded.text,
      truncated: bounded.truncated,
      exitCode: code,
    }
  }

  private discoverSession(text: string) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue
      try {
        const payload = JSON.parse(line)
        if (typeof payload === "object" && payload !== null && typeof payload.sessionID === "string")
          return payload.sessionID
      } catch {
        continue
      }
    }
    return undefined
  }

  private async promptPty(request: PromptRequest): Promise<PromptResult> {
    const terminal = this.proc?.terminal
    if (terminal === undefined) throw new Error(`Child "${this.name}" has no terminal; it may have exited`)
    this.busy = true
    const promptAt = Date.now()
    this.push({ type: "message", at: promptAt, summary: "prompt sent" })
    terminal.write(request.message + "\r")
    const outcome = await waitUntil(
      () => {
        if (this.exitCode !== undefined) return "exited" as const
        const changed = Math.max(this.lastDataAt, this.output.lastContentChange())
        if (changed < promptAt) return undefined
        return Date.now() - changed >= PTY_QUIET_MS ? ("quiet" as const) : undefined
      },
      request.timeoutMs,
      (listener) => this.onNotify(listener),
      () => new Error("timeout"),
    ).catch(() => undefined)
    const bounded = tailText(this.output.text())
    if (outcome === "quiet") {
      this.busy = false
      this.push({ type: "idle", at: Date.now(), summary: "idle: screen quiet" })
    }
    if (outcome === "exited") this.busy = false
    const status: PromptStatus = outcome === "exited" ? "exited" : outcome === "quiet" ? "idle" : "timeout"
    return {
      sessionID: this.sessionID ?? "",
      status,
      text: bounded.text,
      truncated: bounded.truncated,
      ...(outcome === "exited" ? { exitCode: this.exitCode } : {}),
    }
  }

  send(keys: readonly Key[], text: string | undefined) {
    if (this.mode !== "pty") throw new Error(`headless_send is only available in pty mode (this instance is ${this.mode})`)
    const terminal = this.proc?.terminal
    if (terminal === undefined) throw new Error(`Child "${this.name}" has no terminal; it may have exited`)
    if (text !== undefined) terminal.write(text)
    for (const key of keys) terminal.write(keyBytes[key])
    return { ok: true }
  }

  async wait(input: { visible?: string; idle?: boolean; timeoutMs: number }) {
    const startedAt = Date.now()
    const matched = await waitUntil(
      () => (this.matches(input) ? true : undefined),
      input.timeoutMs,
      (listener) => this.onNotify(listener),
      () => new Error("timeout"),
    )
      .then(() => true)
      .catch(() => false)
    return { matched, elapsedMs: Date.now() - startedAt }
  }

  private matches(input: { visible?: string; idle?: boolean }) {
    if (input.idle === true && !this.idleNow()) return false
    if (input.idle === undefined && input.visible === undefined) return false
    if (input.visible === undefined) return true
    return containsVisible(this.output.text(), input.visible)
  }

  /** pty has no execution signal worth reading, so idle means the painted screen stopped changing. */
  private idleNow() {
    if (this.mode !== "pty") return !this.busy
    return Date.now() - Math.max(this.lastDataAt, this.output.lastContentChange()) >= PTY_QUIET_MS
  }

  async stop(force: boolean) {
    if (this.proc === undefined) return { name: this.name, stopped: true }
    const proc = this.proc
    this.busy = false
    if (this.exitCode !== undefined) {
      this.api?.controller.abort()
      return { name: this.name, stopped: true, exitCode: this.exitCode }
    }
    signal(proc.pid, "SIGTERM")
    const graceful = await waitForExit(proc, force ? 2_000 : 5_000)
    if (graceful !== undefined) {
      this.exitCode = graceful
      this.api?.controller.abort()
      return { name: this.name, stopped: true, exitCode: graceful }
    }
    if (!force) return { name: this.name, stopped: false }
    signal(proc.pid, "SIGKILL")
    const killed = await waitForExit(proc, 2_000)
    this.exitCode = killed ?? this.exitCode
    this.api?.controller.abort()
    return { name: this.name, stopped: !processAlive(proc.pid), ...(killed === undefined ? {} : { exitCode: killed }) }
  }

  status() {
    return {
      name: this.name,
      mode: this.mode,
      pid: this.pid ?? null,
      alive: this.alive,
      cwd: this.cwd,
      busy: this.busy,
      startedAt: this.startedAt,
      sessionID: this.currentSession,
      url: this.url,
      tools: this.tools,
      version: this.version,
    }
  }
}

export { parseModel }