# Headless

An opt-in OpenCode plugin that lets an agent drive other OpenCode instances to completion. Start a child in a working
directory, prompt it, watch what it does, wait for it to finish or stall, capture its output, and stop it. No human at a
keyboard, and no way to hijack the instance the plugin is running inside.

## Install

Install from its own repository:

```sh
opencode plugin add 'git+https://github.com/paumkim/opencode-headless.git'
```

Or add the directory to `plugins` in the project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/plugins/headless"],
}
```

The plugin exports `index.ts` directly. There is no build step and no installation hook. `effect` is a peer dependency
and is never bundled.

## Tools

All nine tools set `options: { codemode: false }`: they are stateful and long-running. Inputs and outputs are Effect
schemas. Results are capped to the tail at 200 lines or 16 KiB, with `truncated: true` when anything was dropped.

| Tool | Purpose |
| --- | --- |
| `headless_start` | Start a child in `cwd`. `mode` is `api` (default), `cli` or `pty`. Names are unique: starting an existing name fails. |
| `headless_prompt` | Send a message and wait for idle. Returns `idle`, `timeout`, `error` or `exited`, plus the assistant text. |
| `headless_events` | Normalised events: `message`, `tool`, `permission`, `error`, `idle`. One bounded line each, never raw JSON. |
| `headless_capture` | Captured output as `text`, `ansi` (pty only) or `json`. Keeps the last `tail` lines. |
| `headless_send` | Send keys and literal text to a pty child: `enter`, `escape`, `ctrl-c`, `up`, `down`, `tab`, `y`, `n`. |
| `headless_wait` | Block until `visible` text appears, or until the child is idle. Event-driven, default 30s. |
| `headless_status` | Read-only inspection: mode, pid, alive, cwd, busy, startedAt, sessionID, url, tools, version. |
| `headless_stop` | SIGTERM, wait, optional SIGKILL. With no `name`, stops every instance this plugin owns. |

### Worked example

```jsonc
// 1. Start a child with its own state directory and a private server.
{ "name": "demo", "cwd": "/home/me/project", "model": "opencode/inkling-2-small-free" }

// 2. Ask it to do real work and wait for the turn to end.
{
  "name": "demo",
  "message": "Create hello.txt containing exactly: headless works. Then reply DONE.",
  "timeoutMs": 600000
}
// -> { status: "idle", text: "DONE", sessionID: "ses_...", truncated: false }

// 3. See what it did.
{ "name": "demo", "since": 0 }
// -> [{ type: "message", summary: "prompt delivered" },
//     { type: "tool", summary: "tool write" },
//     { type: "idle", summary: "idle: succeeded" }]

// 4. Stop it and confirm it is gone.
{ "name": "demo", "force": true }
// -> [{ name: "demo", stopped: true, exitCode: 143 }]
```

A stalled turn looks the same except for the status:

```jsonc
// A tool needs approval and auto is false.
{ "name": "demo", "message": "Run the tests.", "timeoutMs": 60000 }
// -> { status: "timeout", text: "..." }   // the child is still alive
{ "name": "demo" }                        // events include { type: "permission", ... }
{ "name": "demo", "force": true }
```

## Isolation

Each child gets its own `XDG_STATE_HOME`. It cannot read or write the host's service registration, so it can never
register into the daemon the driver is talking to. `api` children bind `127.0.0.1` on port `0`. `--standalone` is added
when the installed version advertises it, but the state isolation is the actual guarantee.

The plugin never builds a shell string. Every child is spawned from an argv array, and `cwd` must be absolute and inside
the driving session's project roots unless the call passes `allowOutsideRoot: true`.

Nesting is bounded by `OPENCODE_HEADLESS_DEPTH`, incremented per child. At the limit (default 3, override with
`OPENCODE_HEADLESS_MAX_DEPTH`) `headless_start` refuses, so an agent cannot fork-bomb itself.

Children are reaped on normal stop, on plugin unload, on scope close, and by a last-resort `process.on("exit")` hook.
`headless_stop` with `force: false` reports `stopped: false` for a child that survives SIGTERM and leaves it registered.
`force: true` sends SIGKILL.

## Inheriting the installed OpenCode

Nothing about the harness is hardcoded. At start the plugin probes the real binary:

- `opencode --version`, `opencode --help`, `opencode serve --help`, `opencode run --help`
- subcommands present, and which flags those versions still accept
- the child's HTTP API prefix, by probing `/api` and `` and rejecting the web app's HTML

No OpenCode client library is linked. The plugin talks to the child with `fetch` and an SSE frame decoder, so an
upgraded host does not drag a mismatched client build into the plugin. Probe results are cached for 30 seconds by binary
path and mtime, which means an upgrade is picked up by the next `headless_start` without restarting the host.
`OPENCODE_HEADLESS_BIN` overrides the binary path.

## Known limits

- `pty` text capture is a screen reconstruction, not a terminal emulator. Use `ansi` when exact bytes matter. Idle means
  the painted text stopped changing.
- `cli` instances have no process between prompts, so `alive` is false and `pid` is null while idle.
- Provider and credential management for the child is out of scope: it inherits the host's credentials.
- Remote hosts, Windows, and multi-child scheduling are out of scope. `pty` needs a POSIX pseudo-terminal.
- Prompt timeout never kills a child. Callers own that decision.

## Develop

```sh
cd packages/plugins/headless
bun test                                              # unit and lifecycle tests
OPENCODE_HEADLESS_TEST_MODEL=opencode/inkling-2-small-free bun test   # adds real-model tests
OPENCODE_HEADLESS_TEST_PTY=1 bun test test/cli.test.ts # adds the TUI test
bun run typecheck:tsc
```

The standalone repository is generated from this directory. From here, run `bun run script/standalone.ts` to copy,
commit, and (with `--push`) publish it.

## Remove

```sh
opencode plugin remove 'git+https://github.com/paumkim/opencode-headless.git'
```