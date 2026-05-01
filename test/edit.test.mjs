import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile, utimes, writeFile } from "node:fs/promises"
import { cleanupTempDirs, fixture, handlers, resetTestState, serialsOf } from "./test-utils.mjs"

afterEach(async () => {
  resetTestState()
  await cleanupTempDirs()
})

describe("edit handler behavior", () => {
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
    const r1 = await handlers.read({ path: file })
    const begin = r1.value.match(/([A-Z]+)\|b/)?.[1]
    
    const insert = await handlers.edit({ begin, endExclusive: begin, content: "x\ny" })
    assert.equal(insert.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nx\ny\nb\nc\n")

    const r3 = await handlers.read({ path: file })
    const delBegin = r3.value.match(/([A-Z]+)\|y/)?.[1]
    const delEnd = r3.value.match(/([A-Z]+)\|b/)?.[1]

    const remove = await handlers.edit({ begin: delBegin, endExclusive: delEnd, content: "" })
    assert.equal(remove.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nx\nb\nc\n")
  })

  it("uses sentinel serial as endExclusive to edit the last line", async () => {
    const { file } = await fixture("a\nb\nc\n")
    const read = await handlers.read({ path: file })
    const serials = serialsOf(read.value)

    const result = await handlers.edit({ begin: serials[2], endExclusive: serials[3], content: "C" })
    assert.equal(result.ok, true)
    assert.equal(await readFile(file, "utf8"), "a\nb\nC\n")
  })

  it("edits an empty file using sentinel begin and endExclusive", async () => {
    const { file } = await fixture("")
    const read = await handlers.read({ path: file })
    const serial = serialsOf(read.value)[0]

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

    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: sB, endExclusive: sC, content: "ONE" }),
      handlers.edit({ begin: sC, endExclusive: sEnd, content: "TWO" }),
    ])
    const content = await readFile(file, "utf8")
    assert.ok(r1.ok || r2.ok)
    assert.ok(content.includes("ONE") || content.includes("TWO"))
  })

  it("allows concurrent edits to different files", async () => {
    const fa = await fixture("a\nb\nc\n")
    const fb = await fixture("x\ny\nz\n")
    const ra = await handlers.read({ path: fa.file })
    const rb = await handlers.read({ path: fb.file })
    const sfa = serialsOf(ra.value)
    const sfb = serialsOf(rb.value)

    const [r1, r2] = await Promise.all([
      handlers.edit({ begin: sfa[1], endExclusive: sfa[2], content: "B" }),
      handlers.edit({ begin: sfb[1], endExclusive: sfb[2], content: "Y" }),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(await readFile(fa.file, "utf8"), "a\nB\nc\n")
  })

  it("rejects stale, cross-file, reversed, and externally changed serials", async () => {
    const fa = await fixture("a\nb\nc\n")
    const fb = await fixture("d\ne\n")
    const ra = await handlers.read({ path: fa.file })
    const rb = await handlers.read({ path: fb.file })
    const [sa1, sa2, sa3] = serialsOf(ra.value)
    const [sb1] = serialsOf(rb.value)

    await handlers.edit({ begin: sa2, endExclusive: sa3, content: "B" })
    assert.match((await handlers.edit({ begin: sa2, endExclusive: sa3, content: "x" })).error, /stale/)
    assert.match((await handlers.edit({ begin: sa1, endExclusive: sb1, content: "x" })).error, /multiple files/)
    assert.match((await handlers.edit({ begin: sa3, endExclusive: sa1, content: "x" })).error, /reversed/)

    const rc = await handlers.read({ path: fb.file })
    const [sc1, sc2] = serialsOf(rc.value)
    await writeFile(fb.file, "changed\n", "utf8")
    await utimes(fb.file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    assert.match((await handlers.edit({ begin: sc1, endExclusive: sc2, content: "x" })).error, /changed outside/)
  })

  it("serial numbers remain stable after editing unrelated lines", async () => {
    const { file } = await fixture("a\nb\nc\nd\ne\n")
    const read1 = await handlers.read({ path: file })
    const ser1 = serialsOf(read1.value)

    await handlers.edit({ begin: ser1[2], endExclusive: ser1[3], content: "C" })

    const read2 = await handlers.read({ path: file })
    const ser2 = serialsOf(read2.value)
    assert.equal(ser2[0], ser1[0])
    assert.equal(ser2[1], ser1[1])
  })
})
