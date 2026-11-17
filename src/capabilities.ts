import { statSync } from "node:fs"
import { resolveBinary } from "./process.js"

// The harness ships often. Everything the plugin needs to know about it is probed from the installed binary instead of
// being hardcoded: version, subcommands, and which flags that version still accepts. A cached probe keeps a burst of
// headless_start calls cheap without freezing the answer for long, so an upgraded opencode is picked up on its own.

export interface BinaryCapabilities {
  readonly binary: string
  readonly version: string
  readonly subcommands: ReadonlySet<string>
  readonly flags: ReadonlySet<string>
  readonly probedAt: number
}

const CACHE_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
const cache = new Map<string, BinaryCapabilities>()

async function run(binary: string, argv: readonly string[]) {
  const proc = Bun.spawn({ cmd: [binary, ...argv], stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, text: `${stdout}\n${stderr}` }
}

function collectFlags(text: string) {
  const flags = new Set<string>()
  for (const match of text.matchAll(/--([a-z0-9][a-z0-9-]*)/gu)) flags.add(match[1]!)
  return flags
}

async function probe(binary: string): Promise<BinaryCapabilities> {
  const version = await run(binary, ["--version"])
  const help = await run(binary, ["--help"])
  const serve = await run(binary, ["serve", "--help"])
  const runHelp = await run(binary, ["run", "--help"])
  const subcommands = new Set<string>()
  if (/\bserve\b/u.test(help.text)) subcommands.add("serve")
  if (/\brun\b/u.test(help.text)) subcommands.add("run")
  if (serve.code === 0 && !/unknown|unrecognized|invalid subcommand/iu.test(serve.text)) subcommands.add("serve")
  if (runHelp.code === 0) subcommands.add("run")
  const flags = new Set([...collectFlags(help.text), ...collectFlags(serve.text), ...collectFlags(runHelp.text)])
  return {
    binary,
    version: version.text.split("\n").find((line) => /\d+\.\d+/u.test(line))?.trim() ?? "unknown",
    subcommands,
    flags,
    probedAt: Date.now(),
  }
}

/** Probes with a short TTL. The cache key includes mtime so a replaced binary is never served from cache. */
export async function capabilities(override?: string) {
  const binary = resolveBinary(override)
  const mtime = statSync(binary).mtimeMs
  const key = `${binary}:${mtime}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.probedAt < CACHE_TTL_MS) return cached
  const result = await probe(binary)
  cache.set(key, result)
  return result
}

/** Builds argv only from flags this version advertises, and fails loudly when a required subcommand is gone. */
export function serveArgv(caps: BinaryCapabilities) {
  if (!caps.subcommands.has("serve"))
    throw new Error(
      `This opencode (${caps.version}) has no "serve" subcommand, so api mode is unavailable. Use mode cli or pty.`,
    )
  return [
    caps.binary,
    "serve",
    ...(caps.flags.has("hostname") ? ["--hostname", "127.0.0.1"] : []),
    ...(caps.flags.has("port") ? ["--port", "0"] : []),
  ]
}

export function runArgv(caps: BinaryCapabilities, input: { message: string; session?: string; agent?: string; model?: string; auto: boolean }) {
  if (!caps.subcommands.has("run"))
    throw new Error(`This opencode (${caps.version}) has no "run" subcommand, so cli mode is unavailable. Use mode api or pty.`)
  const json = caps.flags.has("format")
  return {
    argv: [
      caps.binary,
      "run",
      ...(caps.flags.has("standalone") ? ["--standalone"] : []),
      ...(json ? ["--format", "json"] : []),
      ...(input.session === undefined ? [] : ["--session", input.session]),
      ...(input.agent === undefined ? [] : ["--agent", input.agent]),
      ...(input.model === undefined ? [] : ["--model", input.model]),
      ...(input.auto && caps.flags.has("auto") ? ["--auto"] : []),
      input.message,
    ],
    json,
  }
}

export function tuiArgv(caps: BinaryCapabilities, input: { cwd: string; auto: boolean }) {
  return [
    caps.binary,
    ...(caps.flags.has("standalone") ? ["--standalone"] : []),
    ...(input.auto && caps.flags.has("auto") ? ["--auto"] : []),
    input.cwd,
  ]
}