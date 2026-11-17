import { Schema } from "effect"
import { noTimeoutFetch } from "./process.js"

// The child's HTTP contract is discovered, not imported. No opencode client library is pinned, so the plugin keeps
// working when the installed harness adds or renames things, as long as the routes it needs are still there.
const Created = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
const Part = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
})
const Message = Schema.Struct({ type: Schema.String, content: Schema.optionalKey(Schema.Array(Part)) })
const Messages = Schema.Struct({ data: Schema.Array(Message) })
const Wire = Schema.Struct({
  type: Schema.String,
  created: Schema.optionalKey(Schema.Number),
  data: Schema.optionalKey(Schema.Unknown),
})

export type Message = typeof Message.Type
export type WireEvent = typeof Wire.Type

const decodeCreated = Schema.decodeUnknownOption(Created)
const decodeMessages = Schema.decodeUnknownOption(Messages)
const decodeWire = Schema.decodeUnknownOption(Wire)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const API_PREFIXES = ["/api", ""] as const
const API_PROBES = ["/model/default", "/config"] as const
const MAX_ERROR_BODY = 300

export class ApiError extends Error {}

async function describe(response: Response) {
  const body = await response.text().catch(() => "")
  const message = body.length > 0 ? body.slice(0, MAX_ERROR_BODY) : response.statusText
  return new ApiError(`${response.status} ${response.url}: ${message}`)
}

/** A thin client over the child server's live HTTP API, with its prefix discovered per child. */
export class Api {
  private constructor(
    readonly baseUrl: string,
    private readonly prefix: string,
    private readonly headers: Record<string, string>,
  ) {}

  /**
   * Finds the API prefix from a route that needs no arguments. A JSON body means the route exists; the web app's
   * HTML fallback means the prefix is wrong. Retries briefly because the URL is printed just before routing is warm.
   */
  static async connect(baseUrl: string, password: string) {
    const headers = {
      authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
      accept: "application/json",
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const prefix of API_PREFIXES) {
        for (const probe of API_PROBES) {
          const response = await noTimeoutFetch(`${baseUrl}${prefix}${probe}`, { headers }).catch(() => undefined)
          if (response === undefined) continue
          if (response.status === 401) throw new ApiError("Child server rejected the plugin's credentials")
          if (!response.ok) continue
          if (!(response.headers.get("content-type") ?? "").includes("application/json")) continue
          const body = await response.json().catch(() => undefined)
          if (typeof body === "object" && body !== null) return new Api(baseUrl, prefix, headers)
        }
      }
      await Bun.sleep(250)
    }
    throw new ApiError(
      `Could not find the child's HTTP API under ${API_PREFIXES.join(" or ")}. The installed opencode may have moved it.`,
    )
  }

  private url(path: string) {
    return `${this.baseUrl}${this.prefix}${path}`
  }

  private async json(method: string, path: string, body?: unknown) {
    const response = await noTimeoutFetch(this.url(path), {
      method,
      headers: { ...this.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await describe(response)
    if (response.status === 204) return undefined
    return response.json().catch(() => undefined)
  }

  async createSession(directory: string) {
    const decoded = decodeCreated(await this.json("POST", "/session", { location: { directory } }))
    if (decoded._tag === "None") throw new ApiError("Child server returned a session without an id")
    return decoded.value.data.id
  }

  async switchAgent(sessionID: string, agent: string) {
    await this.json("POST", `/session/${encodeURIComponent(sessionID)}/agent`, { agent })
  }

  async switchModel(sessionID: string, model: { providerID: string; id: string }) {
    await this.json("POST", `/session/${encodeURIComponent(sessionID)}/model`, { model })
  }

  async prompt(sessionID: string, text: string) {
    await this.json("POST", `/session/${encodeURIComponent(sessionID)}/prompt`, { text, delivery: "steer" })
  }

  async interrupt(sessionID: string) {
    await this.json("POST", `/session/${encodeURIComponent(sessionID)}/interrupt`, {})
  }

  async replyPermission(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    await this.json("POST", `/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
      decision,
    })
  }

  async messages(sessionID: string): Promise<readonly Message[]> {
    const decoded = decodeMessages(
      await this.json("GET", `/session/${encodeURIComponent(sessionID)}/message?order=asc&limit=200`),
    )
    return decoded._tag === "None" ? [] : decoded.value.data
  }

  /** Server-sent events, split into frames. Heartbeat comments and malformed frames are skipped. */
  async *events(signal: AbortSignal): AsyncGenerator<WireEvent> {
    const response = await noTimeoutFetch(this.url("/event"), {
      headers: { ...this.headers, accept: "text/event-stream" },
      signal,
    })
    if (!response.ok) throw await describe(response)
    if (response.body === null) throw new ApiError("Child server returned no event stream body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let closed = false
    const cancel = () => {
      closed = true
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener("abort", cancel, { once: true })
    while (!closed) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/gu, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        const parsed = data === "" ? undefined : decodeJson(data)
        if (parsed?._tag === "Some") {
          const decoded = decodeWire(parsed.value)
          if (decoded._tag === "Some") yield decoded.value
        }
        boundary = buffer.indexOf("\n\n")
      }
    }
  }
}

export function messageText(messages: readonly Message[]) {
  const chunks: string[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text !== undefined) chunks.push(part.text)
      else if (part.type === "tool") chunks.push(`[${part.name ?? "tool"}]`)
    }
  }
  return chunks.join("\n").trim()
}