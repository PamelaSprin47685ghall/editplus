import { classifyZSegments, mergeXList } from "./segment-utils.js"
import { TagCursor } from "./tag-cursor.js"

export class TagRegistry {
  #nextTag = 1
  #states = new Map()
  #mtimes = new Map()
  #allocations = []
  #minAllocatedTag = 1
  #cleared = new Map()

  hasFile(path) { return this.#states.has(path) }

  removeFile(path) {
    this.#states.delete(path)
    this.#mtimes.delete(path)
    this.#cleared.set(path, this.#nextTag)
    if (this.#cleared.size > 100000) {
      const keys = [...this.#cleared.keys()]
      for (let i = 0; i < Math.min(keys.length, 50000); i++)
        this.#cleared.delete(keys[i])
    }
  }

  assign(path, line, count) {
    if (count <= 0) return []
    let state = this.#states.get(path)
    if (!state) {
      state = { zList: [], xList: [], lastZ: 0, lastX: 0 }
      this.#states.set(path, state)
    }

    const start = this.#nextTag
    this.#nextTag += count
    const seg = { x: start, z: line, len: count }
    state.xList.push(seg)

    let inserted = false
    for (let i = 0; i < state.zList.length; i++) {
      if (state.zList[i].z > seg.z) {
        state.zList.splice(i, 0, seg)
        inserted = true
        break
      }
    }
    if (!inserted) state.zList.push(seg)

    this.#pushAlloc(start, count, path)
    return Array.from({ length: count }, (_, index) => start + index)
  }

  tagForLine(path, line) {
    const state = this.#states.get(path)
    if (!state || state.zList.length === 0) return undefined

    const zList = state.zList
    let i = Math.min(state.lastZ, zList.length - 1)
    while (i > 0 && line < zList[i].z) i--
    while (i < zList.length - 1 && line >= zList[i + 1].z) i++
    state.lastZ = i
    const seg = zList[i]

    if (line >= seg.z && line < seg.z + seg.len) return seg.x + (line - seg.z)
    return undefined
  }

  createCursor(path) {
    const state = this.#states.get(path)
    if (!state) return null
    return new TagCursor(state)
  }

  #getPathForTag(tag) {
    if (this.#allocations.length === 0) return undefined
    let low = 0, high = this.#allocations.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const alloc = this.#allocations[mid]
      if (tag < alloc.x) high = mid - 1
      else if (tag >= alloc.x + alloc.count) low = mid + 1
      else return alloc.path
    }
    return undefined
  }

  #pushAlloc(x, count, path) {
    this.#allocations.push({ x, count, path })
    if (this.#allocations.length > 1000000) {
      this.#allocations = this.#allocations.slice(-500000)
      this.#minAllocatedTag = this.#allocations[0].x
    }
  }

  resolve(tag) {
    const path = this.#getPathForTag(tag)
    if (!path) return undefined
    if (this.#minAllocatedTag > 1 && tag < this.#minAllocatedTag) return { expired: true, stale: true }

    const clearedAt = this.#cleared.get(path)
    if (clearedAt && tag < clearedAt) return { path, line: -1, stale: true, external: true }

    const state = this.#states.get(path)
    if (!state || state.xList.length === 0) return undefined

    const xList = state.xList
    let i = Math.min(state.lastX, xList.length - 1)
    while (i > 0 && tag < xList[i].x) i--
    while (i < xList.length - 1 && tag >= xList[i + 1].x) i++
    state.lastX = i
    const seg = xList[i]

    if (tag >= seg.x && tag < seg.x + seg.len) return { path, line: seg.z + (tag - seg.x), stale: false }
    return { path, line: -1, stale: true }
  }

  edit(path, lo, hi, insertedLineCount) {
    const state = this.#states.get(path)
    if (!state) return []

    const delta = insertedLineCount - (hi - lo)
    const { left, right, splits, drops } = classifyZSegments(state.zList, lo, hi, delta)

    let newTags = []
    let midSeg = null
    if (insertedLineCount > 0) {
      const start = this.#nextTag
      this.#nextTag += insertedLineCount
      midSeg = { x: start, z: lo, len: insertedLineCount }
      this.#pushAlloc(start, insertedLineCount, path)
      newTags = Array.from({ length: insertedLineCount }, (_, i) => start + i)
    }

    state.zList = [...left]
    if (midSeg) state.zList.push(midSeg)
    state.zList.push(...right)
    state.xList = mergeXList(state.xList, drops, splits, midSeg)
    state.lastZ = 0
    state.lastX = 0

    return newTags
  }

  noteMtime(path, mtimeMs) { this.#mtimes.set(path, mtimeMs) }
  mtimeChanged(path, mtimeMs) { return this.#mtimes.has(path) && Math.abs(this.#mtimes.get(path) - mtimeMs) > 100 }

  reset() {
    this.#nextTag = 1
    this.#states.clear()
    this.#mtimes.clear()
    this.#allocations = []
    this.#minAllocatedTag = 1
    this.#cleared.clear()
  }

  _getPathForTag(tag) { return this.#getPathForTag(tag) }
}

export const registry = new TagRegistry()
