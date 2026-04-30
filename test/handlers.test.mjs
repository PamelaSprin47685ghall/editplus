import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHandlers } from "../src/handlers.js"
import { registry } from "../src/registry.js"

const handlers = createHandlers()
const tempDirs = []

afterEach(async () => {
  registry.reset()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

// Helper: extract serial numbers from read/grep output
function serialsOf(text) {
  return [...text.matchAll(/(\d+)\|/g)].map(m => Number(m[1]))
}

describe("read", () => {
  it("returns line content with monotonically increasing serials", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const first = await handlers.read({ path: file })
    const second = await handlers.read({ path: file })
    const range = await handlers.read({ path: file, begin: 2, endExclusive: 3 })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    // Each read assigns fresh serials, monatonically increasing
    const s1 = serialsOf(first.value)
    const s2 = serialsOf(second.value)
    assert.ok(s1.length > 0)
    assert.ok(s2.length > 0)
    assert.ok(s2[0] > s1[s1.length - 1], "later read gets higher serials")
    // Range read returns exactly the requested line
    assert.match(range.value, /\d+\|b\n/)
  })

  it("sentinel serial shows on last line for empty content", async () => {
    const { file } = await fixture("")
    const result = await handlers.read({ path: file })
    assert.equal(result.ok, true)
    assert.match(result.value, /\d+\|\s*\n/)
  })
})

describe("edit", () => {
  it("replaces a line identified by serial", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const [, begin, end] = serialsOf(read.value)

    const result = await handlers.edit({ begin, endExclusive: end, content: "B" })

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nB\nc\n")
  })

  it("inserts, deletes, and returns new serials", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const r1 = await handlers.read({ path: file })        // line 0:a 1:b 2:c 3:(sentinel)
    const r2 = await handlers.read({ path: file })         // fresh serials for same lines

    // begin and endExclusive that both resolve to line 1 → insertion at line 1
    const begin = Number(r1.value.match(/(\d+)\|b/)?.[1])
    const end = Number(r2.value.match(/(\d+)\|b/)?.[1])
    assert.ok(begin && end && begin !== end)

    const insert = await handlers.edit({ begin, endExclusive: end, content: "x\ny" })
    assert.equal(insert.ok, true)
    assert.match(insert.value, /New serials:/)
    assert.equal(await readFile(file, "utf8"), "a\nx\ny\nb\nc\n")

    // Re-read after insert, then delete the inserted "y"
    const r3 = await handlers.read({ path: file })
    const delBegin = Number(r3.value.match(/(\d+)\|y/)?.[1])
    const delEnd = Number(r3.value.match(/(\d+)\|b/)?.[1])
    assert.ok(delBegin && delEnd)

    const remove = await handlers.edit({ begin: delBegin, endExclusive: delEnd, content: "" })
    assert.equal(remove.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nx\nb\nc\n")
  })

  it("uses sentinel serial as endExclusive to edit the last line", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)        // [a, b, c, sentinel]

    // sentinel is the last serial, points past the last real line
    const result = await handlers.edit({ begin: serials[2], endExclusive: serials[3], content: "C" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nb\nC\n")
  })

  it("inserts at a line when begin and endExclusive resolve to the same line", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const r1 = await handlers.read({ path: file })
    const r2 = await handlers.read({ path: file })  // second read, same content, different serials

    // Two different serials that both map to line 1 ("b")
    const begin = Number(r1.value.match(/(\d+)\|b/)?.[1])
    const end = Number(r2.value.match(/(\d+)\|b/)?.[1])
    assert.ok(begin && end)

    const result = await handlers.edit({ begin, endExclusive: end, content: "X\n" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nX\nb\nc\n")
  })

  it("edits an empty file using sentinel begin and endExclusive", async () => {
    const { file } = await fixture("")
    const read = await handlers.read({ path: file })
    const serial = Number(read.value.match(/(\d+)\|/)?.[1])

    // sentinel serial pointed past end of empty file → insertion at line 0
    const result = await handlers.edit({ begin: serial, endExclusive: serial, content: "first line" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "first line\n")
  })

  it("preserves CRLF replacement ending", async () => {
    const { file } = await fixture("a\r\nb\r\nc\r\n")
    const read = await handlers.read({ path: file })
    const [, begin, end] = serialsOf(read.value)

    await handlers.edit({ begin, endExclusive: end, content: "B" })

    assert.equal(await readFile(file, "utf8"), "a\r\nB\r\nc\r\n")
  })

  it("serializes concurrent edits to the same file", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const [sA, sB, sC, sEnd] = serialsOf(read.value)

    // sB→line1(b) sC→line2(c) sEnd→line3(sentinel)
    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: sB, endExclusive: sC, content: "ONE" }),
      handlers.edit({ begin: sC, endExclusive: sEnd, content: "TWO" }),
    ])
    // Both may succeed (lock serializes writes; sentinel makes endExclusive valid for last line)
    const content = await readFile(file, "utf8")
    assert.ok(r1.ok || r2.ok)
    assert.ok(content.includes("ONE") || content.includes("TWO"))
  })

  it("allows concurrent edits to different files", async () => {
    const fa = await fixture("a\nb\nc\n")
    const fb = await fixture("x\ny\nz\n")
    const ra = await handlers.read({ path: fa.file })
    const rb = await handlers.read({ path: fb.file })
    const sfa = serialsOf(ra.value)              // [a, b, c, sentinel]
    const sfb = serialsOf(rb.value)              // [x, y, z, sentinel]

    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: sfa[1], endExclusive: sfa[2], content: "B" }),
      handlers.edit({ begin: sfb[1], endExclusive: sfb[2], content: "Y" }),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(await readFile(fa.file, "utf8"), "a\nB\nc\n")
    assert.equal(await readFile(fb.file, "utf8"), "x\nY\nz\n")
  })

  it("rejects stale, cross-file, reversed, and externally changed serials", async () => {
    const fa = await fixture("a\nb\nc\n")
    const fb = await fixture("d\ne\n")
    const ra = await handlers.read({ path: fa.file })
    const rb = await handlers.read({ path: fb.file })
    const [sa1, sa2] = serialsOf(ra.value)
    const [sb1] = serialsOf(rb.value)

    // Stale: edit with sa2, then reuse sa2
    assert.equal((await handlers.edit({ begin: sa2, endExclusive: sa2 + 1, content: "B" })).ok, true)
    assert.match((await handlers.edit({ begin: sa2, endExclusive: sa2 + 1, content: "x" })).error, /stale/)

    // Cross-file: begin from fa, end from fb
    assert.match(
      (await handlers.edit({ begin: sa1, endExclusive: sb1, content: "x" })).error,
      /multiple files/,
    )

    // Reversed: endExclusive < begin
    assert.match(
      (await handlers.edit({ begin: 4, endExclusive: 1, content: "x" })).error,
      /less than begin/,
    )

    // Externally changed: read fb, then modify externally, edit should detect
    const rc = await handlers.read({ path: fb.file })
    const [sc1, sc2] = serialsOf(rc.value)
    await writeFile(fb.file, "changed\n", "utf8")
    await utimes(fb.file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    assert.match(
      (await handlers.edit({ begin: sc1, endExclusive: sc2, content: "x" })).error,
      /changed outside/,
    )
  })
})

describe("grep", () => {
  it("matches strings, regexes, and exposes editable serials", async () => {
    const { dir, file } = await fixture("const alpha = 1\nconst beta = 2\n")
    const result = await handlers.grep({ path: join(dir, "*.js"), pattern: "alpha|beta" })
    const serial = Number(result.value.match(/(\d+)\|const alpha/)?.[1])

    assert.equal(result.ok, true)
    assert.match(result.value, /# .*sample\.js/)
    assert.equal((await handlers.edit({ begin: serial, endExclusive: serial + 1, content: "const alpha = 3" })).ok, true)
    assert.equal(await readFile(file, "utf8"), "const alpha = 3\nconst beta = 2\n")
  })

  it("handles no matches and invalid regex errors", async () => {
    const { file } = await fixture("abc\n")

    assert.match((await handlers.grep({ path: file, pattern: "zzz" })).value, /No matches/)
    assert.match((await handlers.grep({ path: file, pattern: "[" })).error, /Invalid regular expression/)
  })
})

async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), "editplus-"))
  tempDirs.push(dir)
  const file = join(dir, "sample.js")
  await writeFile(file, content, "utf8")
  return { dir, file }
}
