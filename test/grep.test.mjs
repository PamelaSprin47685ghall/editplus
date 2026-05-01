import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDirs, fixture, handlers, resetTestState, serialsOf } from "./test-utils.mjs"

afterEach(async () => {
  resetTestState()
  await cleanupTempDirs()
})

describe("grep handler behavior", () => {
  it("matches strings, regexes, and exposes editable serials", async () => {
    const { dir, file } = await fixture("const alpha = 1\nconst beta = 2\n")
    const result = await handlers.grep({ projectDir: dir, path: join(dir, "*.js"), pattern: "alpha|beta" })
    const serial = result.value.match(/([A-Z]+)\|const alpha/)?.[1]

    assert.equal(result.ok, true)
    assert.match(result.value, /# .*sample\.js/)
    
    const edit = await handlers.edit({ begin: serial, endExclusive: serialsOf(result.value)[1], content: "const alpha = 3" })
    assert.equal(edit.ok, true)
    assert.equal(await readFile(file, "utf8"), "const alpha = 3\nconst beta = 2\n")
  })

  it("handles no matches gracefully", async () => {
    const { dir, file } = await fixture("abc\n")
    const result = await handlers.grep({ projectDir: dir, path: file, pattern: "zzz" })
    assert.equal(result.ok, true)
    assert.match(result.value, /No matches/)
  })

  it("handles invalid regex errors", async () => {
    const { dir, file } = await fixture("abc\n")
    const result = await handlers.grep({ projectDir: dir, path: file, pattern: "[" })
    assert.equal(result.ok, false)
    assert.match(result.error, /Invalid regular expression/)
  })

  it("rejects missing path or pattern", async () => {
    const { dir } = await fixture("abc\n")
    const r1 = await handlers.grep({ projectDir: dir, pattern: "a" })
    const r2 = await handlers.grep({ projectDir: dir, path: "*" })
    
    assert.equal(r1.ok, false)
    assert.match(r1.error, /path is required/)
    assert.equal(r2.ok, false)
    assert.match(r2.error, /pattern is required/)
  })
})
