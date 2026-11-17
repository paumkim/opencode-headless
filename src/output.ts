// Bounded capture. Every tool result keeps the tail, never the head, and says so with `truncated`.
export const MAX_OUTPUT_LINES = 200
export const MAX_OUTPUT_BYTES = 16 * 1024
const MAX_BUFFER_LINES = 5_000
const MAX_BUFFER_BYTES = 256 * 1024

// CSI, OSC and the short two-byte escapes. Enough to turn a TUI screen into plain text.
const ANSI =
  /[\u001b\u009b](?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu

export function stripAnsi(text: string) {
  return text.replace(ANSI, "")
}

export function tailText(text: string, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES) {
  const all = text.split("\n")
  const fromLines = all.slice(Math.max(0, all.length - maxLines))
  let value = fromLines.join("\n")
  const bytes = Buffer.byteLength(value)
  if (bytes > maxBytes) {
    const buf = Buffer.from(value)
    value = buf.subarray(buf.length - maxBytes).toString("utf8")
    // Drop the partial first line left by cutting bytes.
    const firstBreak = value.indexOf("\n")
    if (firstBreak !== -1) value = value.slice(firstBreak + 1)
  }
  return { text: value, truncated: value !== text, lines: value === "" ? 0 : value.split("\n").length }
}

export class OutputBuffer {
  private readonly lines: string[] = []
  private raw = ""
  private partial = ""
  private readonly decoder = new TextDecoder()
  private readonly ansi: boolean
  private readonly listeners = new Set<() => void>()
  private readonly lineListeners = new Set<(line: string) => void>()
  private contentHash = 0
  private changedAt = Date.now()

  constructor(options: { ansi: boolean }) {
    this.ansi = options.ansi
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onLine(listener: (line: string) => void) {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  push(chunk: Uint8Array) {
    const decoded = this.decoder.decode(chunk, { stream: true })
    if (this.ansi) {
      this.raw = (this.raw + decoded).slice(-MAX_BUFFER_BYTES)
      this.appendLines(stripAnsi(decoded))
    } else {
      this.appendLines(decoded)
    }
    this.listeners.forEach((listener) => listener())
  }

  /**
   * Splits on CRLF, LF and lone CR. A lone CR overwrites the current line, which is how a TUI repaints, so the text
   * before it is discarded instead of becoming a new line.
   */
  private appendLines(text: string) {
    const source = this.partial + text
    const pieces = source.split(/\r\n|\r|\n/u)
    const separators = source.match(/\r\n|\r|\n/gu) ?? []
    this.partial = pieces.pop() ?? ""
    pieces.forEach((piece, index) => {
      if (separators[index] === "\r") return
      this.lines.push(piece)
      this.lineListeners.forEach((listener) => listener(piece))
    })
    if (this.lines.length > MAX_BUFFER_LINES) this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES)
    const hash = hashText(this.text())
    if (hash !== this.contentHash) {
      this.contentHash = hash
      this.changedAt = Date.now()
    }
  }

  /** When the visible text last changed. Unlike byte arrival, cursor blinks and repaints do not move it. */
  lastContentChange() {
    return this.changedAt
  }

  /** Flushes the trailing partial line so `visible` can match text a child printed without a newline. */
  text() {
    if (this.partial !== "") return [...this.lines, this.partial].join("\n")
    return this.lines.join("\n")
  }

  ansiText() {
    return this.raw
  }

  lineCount() {
    return this.lines.length + (this.partial === "" ? 0 : 1)
  }
}

/** True when `needle` appears, ignoring ANSI so a coloured TUI line still matches. */
export function containsVisible(text: string, needle: string) {
  return stripAnsi(text).includes(needle)
}
function hashText(value: string) {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return hash
}
