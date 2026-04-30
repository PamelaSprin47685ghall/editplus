import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { read, splitLines, withLock } from "../src/io.js"
import { registry } from "../src/registry.js"

const tempDirs = []
afterEach(async () => {
  registry.reset()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("io", () => {
  it("splits empty and preserves all line endings", () => {
    assert.deepEqual(splitLines(""), [])
    assert.deepEqual(splitLines("a\nb"), ["a\n", "b"])
    assert.deepEqual(splitLines("a\r\nb\r\n"), ["a\r\n", "b\r\n"])
    assert.deepEqual(splitLines("a\rb"), ["a\r", "b"])
  })

  it("reads mtime, whole content, and preserved lines", async () => {
    const dir = await tempDir()
    const file = join(dir, "sample.txt")
    await writeFile(file, "a\r\nb", "utf8")

    const result = await read(file)
    assert.equal(result.whole_content, "a\r\nb")
    assert.deepEqual(result.lines, ["a\r\n", "b"])
    assert.equal(typeof result.mtimeMs, "number")
  })

  it("serializes operations on the same path", async () => {
    const order = []
    const result = await Promise.all([
      withLock("/same", async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); order.push(2) }),
      withLock("/same", async () => { order.push(3) }),
    ])
    // Second call (3) must wait for first (1,2) to finish
    assert.deepEqual(order, [1, 2, 3])
    assert.equal(result[0], undefined)
    assert.equal(result[1], undefined)
  })

  it("allows concurrent operations on different paths", async () => {
    const order = []
    const result = await Promise.all([
      withLock("/a", async () => { order.push(1); await new Promise(r => setTimeout(r, 10)); order.push(2) }),
      withLock("/b", async () => { order.push(3) }),
    ])
    // /b runs in parallel with /a — 3 appears before 2
    assert.deepEqual(order, [1, 3, 2])
  })
})

describe("registry", () => {
  it("assigns global monotonic serials and resolves derived lines", () => {
    assert.deepEqual(registry.assign("/a", 2, 3), [1, 2, 3])
    assert.deepEqual(registry.assign("/b", 0, 1), [4])
    assert.deepEqual(registry.resolve(2), { path: "/a", line: 3, stale: false })
  })

  it("stales edited serials and shifts following lines", () => {
    registry.assign("/f", 0, 4)
    const inserted = registry.edit("/f", 1, 3, 1)

    assert.deepEqual(inserted, [5])
    assert.equal(registry.resolve(2).stale, true)
    assert.equal(registry.resolve(3).stale, true)
    assert.deepEqual(registry.resolve(4), { path: "/f", line: 2, stale: false })
    assert.deepEqual(registry.resolve(5), { path: "/f", line: 1, stale: false })
  })
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "editplus-"))
  tempDirs.push(dir)
  return dir
}
