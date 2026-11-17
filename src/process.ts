import path from "node:path"
import { OutputBuffer } from "./output.js"

export interface Spawned {
  readonly proc: Bun.Subprocess
  readonly output: OutputBuffer
}

/**
 * Resolves the opencode executable for a child. `process.execPath` is the compiled binary when the host runs as one;
 * under `bun test` or `bun run dev` it is Bun itself, so fall back to PATH. `OPENCODE_HEADLESS_BIN` overrides both.
 */
export function resolveBinary(override?: string) {
  const explicit = override ?? process.env.OPENCODE_HEADLESS_BIN
  if (explicit) return explicit
  const exec = process.execPath
  const name = path.basename(exec).toLowerCase()
  if (name.includes("opencode")) return exec
  const found = Bun.which("opencode")
  if (found) return found
  throw new Error(
    "Could not find the opencode executable. Set OPENCODE_HEADLESS_BIN to its path, or run under the opencode binary.",
  )
}

export function spawnProcess(input: {
  argv: readonly string[]
  cwd: string
  env: Record<string, string | undefined>
  ansi: boolean
  terminal?: { cols: number; rows: number }
}): Spawned {
  const output = new OutputBuffer({ ansi: input.ansi })
  const terminal =
    input.terminal === undefined
      ? undefined
      : {
          cols: input.terminal.cols,
          rows: input.terminal.rows,
          data: (_terminal: Bun.Terminal, data: Uint8Array) => output.push(data),
        }
  const proc = Bun.spawn({
    cmd: [...input.argv],
    cwd: input.cwd,
    env: input.env,
    stdin: terminal === undefined ? "ignore" : undefined,
    stdout: terminal === undefined ? "pipe" : undefined,
    stderr: terminal === undefined ? "pipe" : undefined,
    terminal,
  })
  if (proc.stdout) void pump(proc.stdout, output)
  if (proc.stderr) void pump(proc.stderr, output)
  return { proc, output }
}

async function pump(stream: ReadableStream<Uint8Array>, output: OutputBuffer) {
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return
    if (next.value) output.push(next.value)
  }
}

/** Resolves on the first check that yields a value, or rejects with `onTimeout()` when the budget runs out. */
export function waitUntil<T>(
  check: () => T | undefined,
  timeoutMs: number,
  subscribe: (listener: () => void) => () => void,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (value: T | undefined, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve(value as T)
    }
    const attempt = () => {
      const value = check()
      if (value !== undefined) finish(value)
    }
    const timer = setTimeout(() => finish(undefined, onTimeout()), timeoutMs)
    const unsubscribe = subscribe(attempt)
    attempt()
  })
}

export interface ServerEndpoint {
  readonly url: string
  readonly password: string
}

export function parseEndpoint(text: string): Partial<ServerEndpoint> {
  const url = /server listening on (http:\/\/\S+)/u.exec(text)?.[1]
  const password = /server password (\S+)/u.exec(text)?.[1]
  return { ...(url === undefined ? {} : { url }), ...(password === undefined ? {} : { password }) }
}

/** `kill(pid, 0)` throws when the process is gone; that probe is the only way to ask the OS. */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function signal(pid: number, value: NodeJS.Signals) {
  try {
    process.kill(pid, value)
    return true
  } catch {
    return false
  }
}

/** Waits for `proc.exited`, or resolves undefined when the process is still running at the deadline. */
export async function waitForExit(proc: Bun.Subprocess, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  const code = await Promise.race([proc.exited, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return code
}

export const noTimeoutFetch = ((request: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(request, { ...init, timeout: false } as BunFetchRequestInit)) as typeof fetch