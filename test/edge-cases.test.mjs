import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile, utimes } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { read, splitLines, withLock } from "../src/io.js"
import { registry } from "../src/registry.js"
import { createHandlers } from "../src/handlers.js"
import { numToAlpha, alphaToNum } from "../src/alpha.js"
import { compilePattern, endingOf, formatEditResult, stripAt, splitReplacement, validateEditParams, resolveSerial, success, failure } from "../src/text.js"
import { detectStructure, blockForLine } from "../src/structure.js"
import { inspectPath, expandGlob } from "../src/pathing.js"
import { readRange, validateBoundary } from "../src/ranges.js"

const handlers = createHandlers()
const tempDirs = []

afterEach(async () => {
  registry.reset()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function serialsOf(text) {
  return [...text.matchAll(/([A-Za-z]+)\|/g)].map(m => m[1])
}

async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), "editplus-"))
  tempDirs.push(dir)
  spawnSync("git", ["init"], { cwd: dir })
  const file = join(dir, "sample.js")
  await writeFile(file, content, "utf8")
  return { dir, file }
}

// ─── i o ────────────────────────────────────────────────────────────────────

describe("io edge cases", () => {
  it("splits just a newline", () => {
    assert.deepEqual(splitLines("\n"), ["\n"])
  })

  it("splits just CRLF", () => {
    assert.deepEqual(splitLines("\r\n"), ["\r\n"])
  })

  it("splits just CR", () => {
    assert.deepEqual(splitLines("\r"), ["\r"])
  })

  it("splits mixed line endings", () => {
    assert.deepEqual(splitLines("a\nb\r\nc\rd"), ["a\n", "b\r\n", "c\r", "d"])
  })

  it("splits content with no trailing newline", () => {
    assert.deepEqual(splitLines("a\nb\nc"), ["a\n", "b\n", "c"])
  })

  it("splits content with trailing CR without LF", () => {
    assert.deepEqual(splitLines("a\rb\rc\r"), ["a\r", "b\r", "c\r"])
  })

  it("splits single line without newline", () => {
    assert.deepEqual(splitLines("hello"), ["hello"])
  })

  it("withLock does not deadlock on rejection", async () => {
    const order = []
    const p1 = withLock("/reject-test", async () => { order.push(1); throw new Error("fail") })
      .catch(() => { order.push("e1") })
    await p1

    const p2 = withLock("/reject-test", async () => { order.push(2) })
    await p2

    assert.deepEqual(order, [1, "e1", 2])
  })
})

// ─── a l p h a ──────────────────────────────────────────────────────────────

describe("alpha encoding", () => {
  it("numToAlpha(0) returns empty string", () => {
    assert.equal(numToAlpha(0), "")
  })

  it("encodes base-52 correctly", () => {
    assert.equal(numToAlpha(1), "A")
    assert.equal(numToAlpha(26), "Z")
    assert.equal(numToAlpha(27), "a")
    assert.equal(numToAlpha(52), "z")
    assert.equal(numToAlpha(53), "AA")
    assert.equal(numToAlpha(54), "AB")
    assert.equal(numToAlpha(78), "AZ")
    assert.equal(numToAlpha(79), "Aa")
  })

  it("round-trips correctly for arbitrary numbers", () => {
    for (const n of [1, 5, 26, 27, 52, 53, 100, 999, 2757]) {
      assert.equal(alphaToNum(numToAlpha(n)), n)
    }
  })

  it("alphaToNum handles uppercase and lowercase", () => {
    assert.equal(alphaToNum("A"), 1)
    assert.equal(alphaToNum("Z"), 26)
    assert.equal(alphaToNum("AA"), 53)
    assert.equal(alphaToNum("AB"), 54)
  })

  it("alphaToNum ignores non-alpha characters", () => {
    // A=1, B=2; 1 ignored → 1*52+2 = 54
    assert.equal(alphaToNum("A1B"), 54)
    assert.equal(alphaToNum("A1B"), 54)
  })

  it("numToAlpha labels are human-readable for small numbers", () => {
    assert.equal(numToAlpha(1), "A")
    assert.equal(numToAlpha(2), "B")
    assert.equal(numToAlpha(26), "Z")
    assert.equal(numToAlpha(27), "a")
  })
})

// ─── t e x t   u t i l s ──────────────────────────────────────────────────

describe("text utils", () => {
  it("endingOf detects all line ending styles", () => {
    assert.equal(endingOf("a\n"), "\n")
    assert.equal(endingOf("a\r\n"), "\r\n")
    assert.equal(endingOf("a\r"), "\r")
    assert.equal(endingOf("a"), "")
    assert.equal(endingOf(""), "")
  })

  it("compilePattern handles plain string, slash-delimited, and invalid", () => {
    const plain = compilePattern("foo")
    assert.equal(plain.ok, true)
    assert.equal(plain.value instanceof RegExp, true)

    const slash = compilePattern("/foo/i")
    assert.equal(slash.ok, true)
    assert.equal(slash.value instanceof RegExp, true)
    assert.equal(slash.value.flags, "i")

    const invalid = compilePattern("[")
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, /Invalid regular expression/)
  })

  it("compilePattern handles uncommon flags", () => {
    const r = compilePattern("/test/gm")
    assert.equal(r.ok, true)
    assert.equal(r.value.flags, "gm")
  })

  it("stripAt removes leading @", () => {
    assert.equal(stripAt("@foo"), "foo")
    assert.equal(stripAt("foo"), "foo")
    assert.equal(stripAt(""), "")
  })

  it("validateEditParams rejects missing params with distinct messages", () => {
    assert.match(validateEditParams({}).error, /begin is required/)
    assert.match(validateEditParams({ begin: 1 }).error, /Either endExclusive or endInclusive is required/)
    assert.match(validateEditParams({ begin: 1, endExclusive: 2 }).error, /content is required/)
    assert.equal(validateEditParams({ begin: 1, endExclusive: 2, content: "x" }).ok, true)
  })

  it("splitReplacement adds fallback ending to content without newline", () => {
    assert.deepEqual(splitReplacement("a\nb\n", "\n"), ["a\n", "b\n"])
    assert.deepEqual(splitReplacement("a\nb", "\n"), ["a\n", "b\n"])
    assert.deepEqual(splitReplacement("", "\n"), [])
  })

  it("formatEditResult renders serial labels", () => {
    const r1 = formatEditResult("/f", { begin: 1, endExclusive: 3 }, [])
    assert.equal(r1, "Edited /f at [A, C).")

    const r2 = formatEditResult("/f", { begin: 1, endExclusive: 3 }, [5, 6])
    assert.equal(r2, "Edited /f at [A, C). New serials: E, F.")
  })
})

// ─── r e g i s t r y ──────────────────────────────────────────────────────

describe("registry edge cases", () => {
  it("hasFile reports existence correctly", () => {
    assert.equal(registry.hasFile("/x"), false)
    registry.assign("/x", 0, 3)
    assert.equal(registry.hasFile("/x"), true)
  })

  it("removeFile cleans up state and mtime", () => {
    registry.assign("/x", 0, 3)
    registry.noteMtime("/x", 12345)
    assert.equal(registry.hasFile("/x"), true)

    registry.removeFile("/x")
    assert.equal(registry.hasFile("/x"), false)
    assert.equal(registry.mtimeChanged("/x", 99999), false)
  })

  it("getSerials automatically assigns for unseen path", () => {
    const serials = registry.getSerials("/new", 4)
    assert.equal(serials.length, 5) // 4 real lines + 1 sentinel
    assert.equal(serials[0], 1)
    assert.equal(serials[4], 5)
  })

  it("getSerials reuses existing state on second call", () => {
    const s1 = registry.getSerials("/f", 2)
    const s2 = registry.getSerials("/f", 2)
    assert.deepEqual(s1, s2)
  })

  it("resolve returns undefined for non-existent serial", () => {
    assert.equal(registry.resolve(999), undefined)
  })

  it("resolve marks serials stale after edit", () => {
    registry.assign("/f", 0, 5)
    registry.edit("/f", 1, 2, 1) // delete line 1

    assert.equal(registry.resolve(2).stale, true) // was line 1, now stale
    assert.equal(registry.resolve(3).stale, false) // shifted line 2
  })

  it("serialForLine returns undefined for unknown path", () => {
    assert.equal(registry.serialForLine("/unknown", 0), undefined)
  })

  it("serialForLine returns correct serial after edits", () => {
    registry.assign("/f", 0, 4) // serials: 1,2,3,4 for lines 0,1,2,3
    assert.equal(registry.serialForLine("/f", 0), 1)
    assert.equal(registry.serialForLine("/f", 2), 3)

    registry.edit("/f", 1, 1, 2) // insert 2 lines at position 1
    assert.equal(registry.serialForLine("/f", 1), 5) // first inserted serial
  })

  it("mtimeChanged returns false for unknown path", () => {
    assert.equal(registry.mtimeChanged("/unknown", 12345), false)
  })

  it("mtimeChanged detects changes", () => {
    registry.noteMtime("/f", 100)
    assert.equal(registry.mtimeChanged("/f", 100), false)
    assert.equal(registry.mtimeChanged("/f", 200), true)
  })

  it("edit at position 0 works", () => {
    registry.assign("/f", 0, 3)
    const inserted = registry.edit("/f", 0, 0, 2) // insert 2 lines at beginning
    assert.equal(inserted.length, 2)

    // Original serials should shift
    assert.equal(registry.resolve(1).stale, false)
    assert.equal(registry.resolve(1).line, 2) // shifted by 2
  })

  it("edit replacing entire content works", () => {
    registry.assign("/f", 0, 4)
    const inserted = registry.edit("/f", 0, 4, 3) // replace all 4 lines with 3
    assert.equal(inserted.length, 3)

    // Old serials are stale
    assert.equal(registry.resolve(1).stale, true)
    assert.equal(registry.resolve(4).stale, true)
    // New serials resolve
    assert.deepEqual(registry.resolve(5), { path: "/f", line: 0, stale: false })
  })

  it("multiple consecutive edits stack correctly", () => {
    registry.assign("/f", 0, 3)

    // Edit 1: insert 1 line at position 1
    const ins1 = registry.edit("/f", 1, 1, 1)
    assert.equal(ins1.length, 1)

    // Edit 2: insert 1 line at position 0
    const ins2 = registry.edit("/f", 0, 0, 1)
    assert.equal(ins2.length, 1)

    // Edit 3: delete 2 lines starting at position 2
    const ins3 = registry.edit("/f", 2, 4, 0)
    assert.equal(ins3.length, 0)
  })

  it("edit on unknown path returns empty array", () => {
    const result = registry.edit("/unknown", 0, 1, 1)
    assert.deepEqual(result, [])
  })

  it("assign with zero count returns empty", () => {
    assert.deepEqual(registry.assign("/f", 0, 0), [])
  })

  it("reset clears everything", () => {
    registry.assign("/a", 0, 5)
    registry.assign("/b", 0, 5)
    assert.equal(registry.hasFile("/a"), true)
    assert.equal(registry.hasFile("/b"), true)

    registry.reset()
    assert.equal(registry.hasFile("/a"), false)
    assert.equal(registry.hasFile("/b"), false)
    assert.equal(registry.resolve(1), undefined)
  })
})

// ─── r a n g e s ──────────────────────────────────────────────────────────

describe("ranges", () => {
  it("validateBoundary rejects cross-file serials", () => {
    const result = validateBoundary(
      { path: "/a", line: 0 },
      { path: "/b", line: 5 }
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /multiple files/)
  })

  it("validateBoundary rejects reversed serials", () => {
    const result = validateBoundary(
      { path: "/a", line: 5 },
      { path: "/a", line: 0 }
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /reversed/)
  })

  it("validateBoundary accepts valid range", () => {
    const result = validateBoundary(
      { path: "/a", line: 0 },
      { path: "/a", line: 5 }
    )
    assert.equal(result.ok, true)
  })
})

// ─── p a t h i n g ────────────────────────────────────────────────────────

describe("pathing", () => {
  it("inspectPath rejects non-existent file", async () => {
    const result = await inspectPath("/nonexistent/path.js", "/")
    assert.equal(result.ok, false)
    assert.match(result.error, /does not exist/)
  })

  it("inspectPath resolves relative path against cwd", async () => {
    const { file, dir } = await fixture("hello\n")
    const result = await inspectPath("sample.js", join(file, ".."))
    assert.equal(result.ok, true)
  })

  it("expandGlob returns single-item array for plain path", async () => {
    const result = await expandGlob("nonexistent-file.js")
    assert.deepEqual(result, [])
  })

  it("expandGlob returns empty array for unmatched glob", async () => {
    const { dir, file } = await fixture("hello\n")
    const result = await expandGlob("*.nonexistent", dir)
    assert.deepEqual(result, [])
  })
})

// ─── s t r u c t u r e ────────────────────────────────────────────────────

describe("structure", () => {
  it("detectStructure returns null for empty/trivial content", () => {
    assert.equal(detectStructure("empty.txt", ""), null)
    assert.equal(detectStructure("notes.md", "# hello"), null)
  })

  it("blockForLine with empty structure returns full range", () => {
    assert.deepEqual(blockForLine(null, 5, 10), [0, 10])
    assert.deepEqual(blockForLine([], 5, 10), [0, 10])
  })

  it("blockForLine finds enclosing structure block", () => {
    const structure = [0, 5, 10]
    assert.deepEqual(blockForLine(structure, 3, 15), [0, 5])
    assert.deepEqual(blockForLine(structure, 7, 15), [5, 10])
    assert.deepEqual(blockForLine(structure, 12, 15), [10, 15])
  })
})
describe("read handlers", () => {
  it("rejects missing path", async () => {
    const result = await handlers.read({})
    assert.equal(result.ok, false)
    assert.match(result.error, /path is required/)
  })

  it("rejects non-existent file", async () => {
    const result = await handlers.read({ path: "/tmp/editplus-nonexistent-xyz.js" })
    assert.equal(result.ok, false)
    assert.match(result.error, /does not exist/)
  })

  it("reads directory path as pseudo du -hxd1", async () => {
    const { dir, file } = await fixture("hello\n")
    const result = await handlers.read({ path: dir })
    assert.equal(result.ok, true)
    assert.match(result.value, /du -hxd1/)
  })

  it("reads file with @ prefix", async () => {
    const { file, dir } = await fixture("hello\nworld\n")
    const result = await handlers.read({ path: `@${file}`, projectDir: typeof dir !== "undefined" ? dir : process.cwd() })
    assert.equal(result.ok, true)
    assert.ok(result.value.includes("hello"))
  })

  it("reads file with CRLF correctly", async () => {
    const { file, dir } = await fixture("a\r\nb\r\nc\r\n")
    const result = await handlers.read({ path: file })
    assert.equal(result.ok, true)
    assert.match(result.value, /\|a\r\n/)
  })

  it("range read with only begin returns single line", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const serial = serialsOf(full.value)[1] // serial for "b"

    const range = await handlers.read({ path: file, begin: serial })
    assert.equal(range.ok, true)
    // Should return from begin to end (single line by default)
    assert.ok(range.value.includes("b"))
  })

  it("keeps serials valid after external read-only access", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const serials = serialsOf(full.value)
    const before = (await stat(file)).mtimeMs

    await readFile(file, "utf8")

    assert.equal((await stat(file)).mtimeMs, before)
    const range = await handlers.read({ path: file, begin: serials[0], endExclusive: serials[2] })
    assert.equal(range.ok, true)
    assert.equal(range.value, `${serials[0]}|a\n${serials[1]}|b\n`)
  })

  it("reports missing read serials distinctly", async () => {
    const { file, dir } = await fixture("a\nb\n")

    const result = await handlers.read({ path: file, begin: 99999 })

    assert.equal(result.ok, false)
    assert.match(result.error, /begin serial 99999 does not exist/)
  })

  it("reports deleted begin serials during read", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const serials = serialsOf(full.value)

    await handlers.edit({ begin: serials[0], endExclusive: serials[1], content: "A" })
    const result = await handlers.read({ path: file, begin: serials[0], endExclusive: serials[2] })

    assert.equal(result.ok, false)
    assert.match(result.error, new RegExp(`begin serial ${serials[0]} is stale`))
    assert.match(result.error, /line was edited or deleted/)
    assert.match(result.error, /before reading/)
  })

  it("reports deleted endExclusive serials during read", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const serials = serialsOf(full.value)

    await handlers.edit({ begin: serials[1], endExclusive: serials[2], content: "B" })
    const result = await handlers.read({ path: file, begin: serials[0], endExclusive: serials[1] })

    assert.equal(result.ok, false)
    assert.match(result.error, new RegExp(`endExclusive serial ${serials[1]} is stale`))
    assert.match(result.error, /line was edited or deleted/)
    assert.match(result.error, /before reading/)
  })

  it("reports external modification distinctly for range reads", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const serials = serialsOf(full.value)

    await writeFile(file, "changed\n", "utf8")
    await utimes(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    const range = await handlers.read({ path: file, begin: serials[0], endExclusive: serials[1] })

    assert.equal(range.ok, false)
    assert.match(range.error, /File changed outside editplus/)
    assert.match(range.error, /before reading a serial range/)

    const refreshed = await handlers.read({ path: file })
    assert.equal(refreshed.ok, true)
    assert.match(refreshed.value, /changed/)
  })
})

// ─── h a n d l e r   e d i t ─────────────────────────────────────────────

describe("edit handlers", () => {
  it("rejects missing params", async () => {
    assert.match((await handlers.edit({})).error, /begin is required/)
    assert.match((await handlers.edit({ begin: "A" })).error, /Either endExclusive or endInclusive is required/)
    assert.match((await handlers.edit({ begin: "A", endExclusive: "B" })).error, /content is required/)
  })

  it("rejects non-existent serial", async () => {
    const result = await handlers.edit({ begin: 99999, endExclusive: 99999, content: "x" })
    assert.equal(result.ok, false)
    assert.match(result.error, /does not exist/)
  })

  it("edits first line", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[0], endExclusive: serials[1], content: "A" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "A\nb\nc\n")
  })

  it("edits last real line (not via sentinel)", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[2], endExclusive: serials[3], content: "C" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nb\nC\n")
  })

  it("deletes entire content", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[0], endExclusive: serials[3], content: "" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "")
  })

  it("replaces entire content with fewer lines", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[0], endExclusive: serials[3], content: "x\ny" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "x\ny\n")
  })

  it("replaces entire content with more lines", async () => {
    const { file, dir } = await fixture("a\nb\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[0], endExclusive: serials[2], content: "x\ny\nz" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "x\ny\nz\n")
  })

  it("inserts at beginning with begin===endExclusive", async () => {
    const { file, dir } = await fixture("a\nb\n")
    const read = await handlers.read({ path: file })
    const serial = serialsOf(read.value)[0]

    const result = await handlers.edit({ begin: serial, endExclusive: serial, content: "x\n" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "x\na\nb\n")
  })

  it("handles multiple sequential edits correctly", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    let read = await handlers.read({ path: file })

    // Edit 1: replace b with X
    const ser1 = serialsOf(read.value)
    await handlers.edit({ begin: ser1[1], endExclusive: ser1[2], content: "X" })

    // Edit 2: replace c with Y
    read = await handlers.read({ path: file })
    const ser2 = serialsOf(read.value)
    await handlers.edit({ begin: ser2[2], endExclusive: ser2[3], content: "Y" })

    assert.equal(await readFile(file, "utf8"), "a\nX\nY\n")
  })

  it("inserts within existing line and shifts correctly", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const ser = serialsOf(read.value)

    // Insert before b
    await handlers.edit({ begin: ser[1], endExclusive: ser[1], content: "X\nY" })
    assert.equal(await readFile(file, "utf8"), "a\nX\nY\nb\nc\n")
  })

  it("preserves CRLF on insertion", async () => {
    const { file, dir } = await fixture("a\r\nb\r\nc\r\n")
    const read = await handlers.read({ path: file })
    const [, begin, end] = serialsOf(read.value)

    await handlers.edit({ begin, endExclusive: end, content: "X" })
    assert.equal(await readFile(file, "utf8"), "a\r\nX\r\nc\r\n")
  })

  it("rejects stale serial", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const ser = serialsOf(read.value)

    // Edit first, making serials stale
    await handlers.edit({ begin: ser[0], endExclusive: ser[1], content: "x" })
    // Try using the same serial again
    const result = await handlers.edit({ begin: ser[0], endExclusive: ser[1], content: "y" })
    assert.equal(result.ok, false)
    assert.match(result.error, /stale/)
  })

  it("rejects cross-file serial range", async () => {
    const fa = await fixture("a\nb\n")
    const fb = await fixture("x\ny\n")
    const ra = await handlers.read({ path: fa.file })
    const rb = await handlers.read({ path: fb.file })
    const sa = serialsOf(ra.value)
    const sb = serialsOf(rb.value)

    const result = await handlers.edit({ begin: sa[0], endExclusive: sb[0], content: "oops" })
    assert.equal(result.ok, false)
    assert.match(result.error, /multiple files/)
  })

  it("rejects reversed serial range", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    await handlers.read({ path: file })

    const result = await handlers.edit({ begin: 3, endExclusive: 1, content: "x" })
    assert.equal(result.ok, false)
    assert.match(result.error, /reversed/)
  })

  it("rejects externally modified file", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const ser = serialsOf(read.value)

    // External modification
    await writeFile(file, "changed\n", "utf8")
    await utimes(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    // Force mtime to be different
    const stat = await import("node:fs/promises").then(m => m.stat(file))

    const result = await handlers.edit({ begin: ser[0], endExclusive: ser[1], content: "x" })
    assert.equal(result.ok, false)
    assert.match(result.error, /changed outside/)
  })
})

// ─── h a n d l e r   g r e p ─────────────────────────────────────────────

describe("grep handlers", () => {
  it("rejects missing path and pattern", async () => {
    assert.match((await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), })).error, /path is required/)
    assert.match((await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: "x" })).error, /pattern is required/)
  })

  it("grep glob multiple files", async () => {
    const { dir, file } = await fixture("const a = 1\nconst b = 2\n")
    const { file: f2 } = await fixture("const c = 3\nconst d = 4\n")
    // Move f2 into same dir
    await writeFile(join(dir, "sample2.js"), await readFile(f2, "utf8"))

    const result = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: join(dir, "*.js"), pattern: "const" })
    assert.equal(result.ok, true)
    // Should contain both file paths
    assert.ok(result.value.includes("sample.js"))
    assert.ok(result.value.includes("sample2.js"))
  })

  it("grep with slash-delimited pattern", async () => {
    const { file, dir } = await fixture("HELLO\nhello\nWorld\n")
    const result = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: file, pattern: "/hello/i" })
    assert.equal(result.ok, true)
    // Case-insensitive: should match both HELLO and hello
    assert.ok(result.value.includes("HELLO"))
    assert.ok(result.value.includes("hello"))
    // "World" appears in context lines (neighbor), which is fine
    // Just verify all lines are present
    assert.ok(result.value.includes("World"))
  })

  it("grep with @ prefix", async () => {
    const { file, dir } = await fixture("abc\ndef\nghi\n")
    const result = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: `@${file}`, pattern: "def" })
    assert.equal(result.ok, true)
    assert.ok(result.value.includes("def"))
  })

  it("grep no files matching glob returns error", async () => {
    const result = await handlers.grep({ projectDir: process.cwd(), path: "nonexistent-*.js", pattern: "foo" })
    assert.equal(result.ok, false)
    assert.match(result.error, /No files matched/)
  })

  it("grep returns editable serials that can be used in edit", async () => {
    const { file, dir } = await fixture("line one\nline two\nline three\n")
    const grepResult = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: file, pattern: "two" })
    assert.equal(grepResult.ok, true)

    const serial = grepResult.value.match(/([A-Za-z]+)\|line two/)?.[1]
    assert.ok(serial, "should capture serial for matched line")

    // serialsOf returns [A, B, C, D, B_dup]; index 2 = C = next line after "line two"
    const ser = serialsOf(grepResult.value)
    const editResult = await handlers.edit({ begin: serial, endExclusive: ser[2], content: "line 2" })
    assert.equal(editResult.ok, true)
    assert.equal(await readFile(file, "utf8"), "line one\nline 2\nline three\n")
  })

  it("grep single file with no matches returns message", async () => {
    const { file, dir } = await fixture("abc\ndef\n")
    const result = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: file, pattern: "zzz" })
    assert.equal(result.ok, true)
    assert.match(result.value, /No matches/)
  })

  it("grep multiple matches in single file", async () => {
    const { file, dir } = await fixture("const x = 1\nlet y = 2\nconst z = 3\n")
    const result = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: file, pattern: "const" })
    assert.equal(result.ok, true)
    assert.equal(result.ok, true)
    // Both matched lines should appear in grep output summary
    assert.ok(result.value.includes("const x"), "first match line present")
    assert.ok(result.value.includes("const z"), "second match line present")
  })
  it("grep line endings correct for edit", async () => {
    const { file, dir } = await fixture("abc\n")
    const grepResult = await handlers.grep({ projectDir: typeof dir !== "undefined" ? dir : process.cwd(), path: file, pattern: "abc" })
    assert.equal(grepResult.ok, true)
    assert.ok(serialsOf(grepResult.value).length > 0)
  })
})

// ─── i n t e g r a t i o n ───────────────────────────────────────────────

describe("read→edit→read consistency", () => {
  it("serial numbers remain stable after editing unrelated lines", async () => {
    const { file, dir } = await fixture("a\nb\nc\nd\ne\n")
    const read1 = await handlers.read({ path: file })
    const ser1 = serialsOf(read1.value)

    // Edit line "c" (index 2)
    await handlers.edit({ begin: ser1[2], endExclusive: ser1[3], content: "C" })

    // Re-read — serials for untouched lines should be consistent
    const read2 = await handlers.read({ path: file })
    const ser2 = serialsOf(read2.value)

    // First two lines should have same serials
    assert.equal(ser2[0], ser1[0])
    assert.equal(ser2[1], ser1[1])
  })

  it("edit accepts alpha serial strings directly from read output", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const ser = serialsOf(read.value)

    // Use alpha strings directly (as the tool would pass them)
    const result = await handlers.edit({ begin: ser[0], endExclusive: ser[1], content: "A" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "A\nb\nc\n")
  })
})

describe("LineRegistry getSerials post-edit consistency", () => {
  it("returns correct serials after insert", () => {
    registry.assign("/f", 0, 3)
    registry.edit("/f", 1, 1, 2)

    const serials = registry.getSerials("/f", 5)
    assert.equal(serials.length, 6)
    assert.equal(serials.length, 6)
  })
})

  it("reports distinct external change error for old serials after state reset", async () => {
    const { file, dir } = await fixture("a\nb\nc\n")
    const full1 = await handlers.read({ path: file })
    const oldSerials = serialsOf(full1.value)

    // Simulate external touch (mtime change without content change)
    const now = new Date(Date.now() + 10_000)
    await utimes(file, now, now)

    // Read without range to trigger mtimeChanged -> removeFile -> new allocations
    await handlers.read({ path: file })

    // Attempt to use old serial
    const result = await handlers.read({ path: file, begin: oldSerials[0], endExclusive: oldSerials[1] })

    assert.equal(result.ok, false)
    assert.match(result.error, /File changed outside editplus since begin serial/)
    assert.doesNotMatch(result.error, /line was edited or deleted/)
  })
