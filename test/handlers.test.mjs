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

describe("read", () => {
  it("assigns global serials and reads exact serial ranges", async () => {
    const { dir, file } = await fixture("a\nb\nc\n")
    const first = await handlers.read({ path: file })
    const second = await handlers.read({ path: file })
    const range = await handlers.read({ path: file, begin: 2, endExclusive: 3 })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.match(first.value, /1\|a/)
    assert.match(second.value, /4\|a/)
    assert.equal(range.value, "8|b\n")
    assert.equal(dir.length > 0, true)
  })

  it("returns empty output for empty files", async () => {
    const { file } = await fixture("")
    assert.deepEqual(await handlers.read({ path: file }), { ok: true, value: "" })
  })
})

describe("edit", () => {
  it("replaces an equal line count by serial range", async () => {
    const { file } = await fixture("a\nb\nc\n")
    await handlers.read({ path: file })

    const result = await handlers.edit({ begin: 2, endExclusive: 3, content: "B" })

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nB\nc\n")
  })

  it("inserts, deletes, and returns new serials", async () => {
    const { file } = await fixture("a\nb\nc\n")
    await handlers.read({ path: file })
    await handlers.read({ path: file })

    const insert = await handlers.edit({ begin: 2, endExclusive: 5, content: "x\ny" })
    await handlers.read({ path: file })
    const remove = await handlers.edit({ begin: 11, endExclusive: 12, content: "" })

    assert.match(insert.value, /New serials: 7, 8/)
    assert.equal(remove.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nx\nb\nc\n")
  })

  it("preserves CRLF replacement ending", async () => {
    const { file } = await fixture("a\r\nb\r\nc\r\n")
    await handlers.read({ path: file })

    await handlers.edit({ begin: 2, endExclusive: 3, content: "B" })

    assert.equal(await readFile(file, "utf8"), "a\r\nB\r\nc\r\n")
  })

  it("serializes concurrent edits to the same file", async () => {
    const { file } = await fixture("a\nb\nc\n")
    await handlers.read({ path: file })
    // Both edits target the same file with different serials
    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: 2, endExclusive: 3, content: "ONE" }),
      handlers.edit({ begin: 3, endExclusive: 4, content: "TWO" }),
    ])
    // At least one succeeds; they can't both succeed because the second
    // will see the file changed (mtime) after the lock serializes access
    const okCount = [r1, r2].filter(r => r.ok).length
    assert.ok(okCount >= 1, "at least one edit must succeed")
    // File content must not be garbled
    const content = await readFile(file, "utf8")
    assert.ok(content.includes("ONE") || content.includes("TWO"))
  })

  it("allows concurrent edits to different files", async () => {
    const fa = await fixture("a\nb\nc\n")
    const fb = await fixture("x\ny\nz\n")
    await handlers.read({ path: fa.file })
    await handlers.read({ path: fb.file })

    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: 2, endExclusive: 3, content: "B" }),
      handlers.edit({ begin: 5, endExclusive: 6, content: "Y" }),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(await readFile(fa.file, "utf8"), "a\nB\nc\n")
    assert.equal(await readFile(fb.file, "utf8"), "x\nY\nz\n")
  })

  it("rejects stale, cross-file, reversed, and externally changed serials", async () => {
    const first = await fixture("a\nb\nc\n")
    const second = await fixture("d\ne\n")
    await handlers.read({ path: first.file })
    await handlers.read({ path: second.file })

    assert.equal((await handlers.edit({ begin: 2, endExclusive: 3, content: "B" })).ok, true)
    assert.match((await handlers.edit({ begin: 2, endExclusive: 3, content: "x" })).error, /stale/)
    assert.match((await handlers.edit({ begin: 1, endExclusive: 4, content: "x" })).error, /multiple files/)
    assert.match((await handlers.edit({ begin: 4, endExclusive: 1, content: "x" })).error, /greater/)

    await handlers.read({ path: second.file })
    await writeFile(second.file, "changed\n", "utf8")
    await utimes(second.file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    assert.match((await handlers.edit({ begin: 7, endExclusive: 8, content: "x" })).error, /changed outside/)
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
