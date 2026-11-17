# ADR: transports and version discovery

## Context

A driving agent needs to start another OpenCode, prompt it, observe it, and stop it, without a human and without
touching the host instance. OpenCode ships often. A plugin that pins a client library, a CLI flag set, or an API prefix
breaks on upgrade in ways the driving agent cannot diagnose.

## Decision 1: choose the transport per instance, `api` by default

`headless_start({ mode })` selects one of three transports, and each operation uses the one that instance has:

| Transport | Used for | Why |
| --- | --- | --- |
| `api` (default) | prompt, events, status, stop | A private `opencode serve` child gives structured execution events (`session.execution.succeeded/failed/interrupted`), permission requests, tool call names, and a session log. Waiting is event-driven, so a timeout is a decision, not a guess. |
| `cli` | one-shot prompts | `opencode run --format json` is the cheapest path and needs no long-lived process. Coarse: one process per prompt, no steering. |
| `pty` | TUI verification | A real TUI in a Bun pseudo-terminal, for screen capture and key injection. Heuristic: idle means the painted text stopped changing. |

Rejected: a single transport for everything. `cli` cannot surface a permission stall or list tool calls while running;
`pty` cannot say why a turn ended. `api` covers every acceptance test, so it is the default, and `pty` is opt-in.

## Decision 2: discover the harness instead of hardcoding it

Nothing about the installed OpenCode is assumed:

1. **Binary** — `capabilities()` runs `opencode --version`, `opencode --help`, `opencode serve --help` and
   `opencode run --help`, then builds argv only from the subcommands and flags that version advertises. A missing
   `serve` makes `api` mode fail with a message that names the version and points at `cli`/`pty`.
2. **API prefix** — `Api.connect` probes `/api` and `` for a JSON route that needs no arguments, retrying briefly
   while the server warms up. HTML (the web app fallback) is rejected as the wrong prefix.
3. **No client library** — the plugin talks to the child over `fetch` plus a small SSE frame decoder. `@opencode/client`
   is not a dependency, so a plugin install cannot drag in a client build that disagrees with the host.
4. **Short cache** — probe results are cached for 30s keyed by binary path and mtime, so an upgrade is picked up by the
   next start without restarting the host.

Consequence: route renames inside the API still break a call, but the error names the exact URL and status, and the
plugin itself needs no release to follow a flag or prefix change.

## Decision 3: isolation is structural, not advisory

- Every child gets `XDG_STATE_HOME=<instance dir>/state`, so it cannot read or write the host's `service.json`.
  A test fingerprints that file before and after a full start/prompt/stop cycle.
- `api` children bind `--port 0` on `127.0.0.1` when the flag exists; `--standalone` is added only when advertised. The
  state isolation, not the flag, is what guarantees the child never joins the host daemon.
- `OPENCODE_HEADLESS_DEPTH` is incremented per child; `headless_start` refuses at the limit (default 3).
- No shell: argv arrays only. Captured output is capped to the tail (200 lines / 16 KiB) with `truncated: true`.

## Decision 4: no blanket approval

`auto` defaults to false. A permission request surfaces as a `permission` event and the prompt times out with the child
alive, so the driving agent can see the stall and decide. `auto: true` replies `once` to each request for that child
only, and is documented as "the child will execute tools without asking".

## Consequences

- `headless_prompt` on a stalled child returns `timeout` and never kills it; callers must call `headless_stop`.
- `pty` text capture is a best-effort screen reconstruction, not a terminal emulator; use `ansi` for exact bytes.
- `cli` instances have no pid between prompts, so `alive` is false while idle.