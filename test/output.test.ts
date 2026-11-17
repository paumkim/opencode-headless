import { describe, expect, test } from "bun:test"
import { OutputBuffer, containsVisible, stripAnsi, tailText } from "../src/output.js"

describe("bounded capture", () => {
  test("keeps the tail and says it truncated", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n")
    const result = tailText(text, 200)
    expect(result.truncated).toBe(true)
    expect(result.lines).toBe(200)
    expect(result.text.endsWith("line 499")).toBe(true)
    expect(result.text.startsWith("line 300")).toBe(true)
  })

  test("does not truncate a short capture", () => {
    const result = tailText("a\nb\nc", 200)
    expect(result).toEqual({ text: "a\nb\nc", truncated: false, lines: 3 })
  })

  test("caps a single huge line at the byte budget", () => {
    const result = tailText("x".repeat(40_000), 200)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024)
  })

  test("strips CSI and OSC sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]0;title\u0007text")).toBe("red text")
  })
})

describe("OutputBuffer", () => {
  test("a lone carriage return overwrites the current line instead of adding one", () => {
    const buffer = new OutputBuffer({ ansi: false })
    buffer.push(new TextEncoder().encode("progress 10%\rprogress 90%\ndone\n"))
    expect(buffer.text()).toBe("progress 90%\ndone")
  })

  test("keeps raw ANSI for pty but plain text for matching", () => {
    const buffer = new OutputBuffer({ ansi: true })
    buffer.push(new TextEncoder().encode("\u001b[32mPONG\u001b[0m\r\n"))
    expect(buffer.ansiText()).toContain("\u001b[32m")
    expect(buffer.text()).toBe("PONG")
    expect(containsVisible(buffer.text(), "PONG")).toBe(true)
  })

  test("notifies per completed line", () => {
    const buffer = new OutputBuffer({ ansi: false })
    const seen: string[] = []
    buffer.onLine((line) => seen.push(line))
    buffer.push(new TextEncoder().encode("one\ntwo\n"))
    expect(seen).toEqual(["one", "two"])
  })

  test("content change tracks visible text, not byte arrival", async () => {
    const buffer = new OutputBuffer({ ansi: true })
    buffer.push(new TextEncoder().encode("stable"))
    const first = buffer.lastContentChange()
    await Bun.sleep(10)
    buffer.push(new TextEncoder().encode("\u001b[0m"))
    expect(buffer.lastContentChange()).toBe(first)
  })
})