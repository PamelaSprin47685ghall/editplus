import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { stat, utimes } from "node:fs/promises"
import { cleanupTempDirs, fixture, handlers, resetTestState, tagsOf } from "./test-utils.mjs"

afterEach(async () => {
  resetTestState()
  await cleanupTempDirs()
})

describe("read handler behavior", () => {
  it("returns line content with monotonically increasing tags", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const first = await handlers.read({ path: file })
    const second = await handlers.read({ path: file })
    const range = await handlers.read({ path: file, begin: "B", endExclusive: "C" })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    const s1 = tagsOf(first.value)
    const s2 = tagsOf(second.value)
    assert.deepEqual(s1, s2, "later read reuses the same tags")
    assert.match(range.value, /([A-Z]+)\|b\n/)
  })

  it("sentinel tag shows on last line for empty content", async () => {
    const { file } = await fixture("")
    const result = await handlers.read({ path: file })
    assert.equal(result.ok, true)
    assert.match(result.value, /([A-Z]+)\|\s*\n/)
  })

  it("defaults missing path to .", async () => {
    const result = await handlers.read({})
    assert.equal(result.ok, true)
    assert.match(result.value, /\$ du -hxd1/)
  })

  it("rejects non-existent file", async () => {
    const result = await handlers.read({ path: "/tmp/editplus-nonexistent-xyz.js" })
    assert.equal(result.ok, false)
    assert.match(result.error, /does not exist/)
  })

  it("reads directory path as pseudo du -hxd1", async () => {
    const { dir } = await fixture("hello\n")
    const result = await handlers.read({ path: dir })
    assert.equal(result.ok, true)
    assert.match(result.value, /du -hxd1/)
  })

  it("reads file with @ prefix", async () => {
    const { file, dir } = await fixture("hello\nworld\n")
    const result = await handlers.read({ path: `@${file}`, projectDir: dir })
    assert.equal(result.ok, true)
    assert.ok(result.value.includes("hello"))
  })

  it("reads file with CRLF correctly", async () => {
    const { file } = await fixture("a\r\nb\r\nc\r\n")
    const result = await handlers.read({ path: file })
    assert.equal(result.ok, true)
    assert.match(result.value, /\|a\r\n/)
  })

  it("range read with only begin returns single line", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const tag = tagsOf(full.value)[1]

    const range = await handlers.read({ path: file, begin: tag })
    assert.equal(range.ok, true)
    assert.ok(range.value.includes("b"))
  })

  it("keeps tags valid after external read-only access", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const full = await handlers.read({ path: file })
    const tags = tagsOf(full.value)
    const before = (await stat(file)).mtimeMs

    await import('node:fs/promises').then(fs => fs.readFile(file, "utf8"))
    const after = (await stat(file)).mtimeMs
    assert.equal(before, after)

    const range = await handlers.read({ path: file, begin: tags[0] })
    assert.equal(range.ok, true)
  })

  it("reports distinct external change error for old tags after state reset", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const full1 = await handlers.read({ path: file })
    const oldTags = tagsOf(full1.value)

    const now = new Date(Date.now() + 10_000)
    await utimes(file, now, now)

    const full2 = await handlers.read({ path: file })
    const newTags = tagsOf(full2.value)
    assert.notDeepEqual(oldTags, newTags)

    const range = await handlers.read({ path: file, begin: oldTags[0] })
    assert.equal(range.ok, false)
    assert.match(range.error, /changed outside/)
  })

  it("auto-attaches current file summary on stale range access", async () => {
    const { file } = await fixture("a\n")
    const full = await handlers.read({ path: file })
    const oldTag = tagsOf(full.value)[0]
    
    await handlers.edit({ begin: oldTag, endExclusive: tagsOf(full.value)[1], content: "x\n" })
    
    const range = await handlers.read({ path: file, begin: oldTag })
    assert.equal(range.ok, false)
    assert.match(range.error, /stale/)
    assert.match(range.error, /Auto-attached current file summary/)
    assert.match(range.error, /\|x\n/)
  })
})
