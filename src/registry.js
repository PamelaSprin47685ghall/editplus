const SENTINEL = 0 // Index of { x: Infinity, z: Infinity } to mark the end of arrays

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

    // xList 天然有序 — start 来自全局递增计数器，必定大于现存所有 x
    state.xList.push(seg)

    // zList 线性插入 — 找到第一个 z 更大的段插入
    let inserted = false
    for (let i = 0; i < state.zList.length; i++) {
      if (state.zList[i].z > seg.z) {
        state.zList.splice(i, 0, seg)
        inserted = true
        break
      }
    }
    if (!inserted) {
      state.zList.push(seg)
    }

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

    if (line >= seg.z && line < seg.z + seg.len) {
      return seg.x + (line - seg.z)
    }

    return undefined
  }

  createCursor(path) {
    const state = this.#states.get(path)
    if (!state) return null
    return new TagCursor(state)
  }

  #getPathForTag(tag) {
    if (this.#allocations.length === 0) return undefined
    let low = 0
    let high = this.#allocations.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const alloc = this.#allocations[mid]
      if (tag < alloc.x) {
        high = mid - 1
      } else if (tag >= alloc.x + alloc.count) {
        low = mid + 1
      } else {
        return alloc.path
      }
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

    if (this.#minAllocatedTag > 1 && tag < this.#minAllocatedTag) {
      return { expired: true, stale: true }
    }

    const clearedAt = this.#cleared.get(path)
    if (clearedAt && tag < clearedAt) {
      return { path, line: -1, stale: true, external: true }
    }

    const state = this.#states.get(path)
    if (!state || state.xList.length === 0) return undefined

    const xList = state.xList
    let i = Math.min(state.lastX, xList.length - 1)

    while (i > 0 && tag < xList[i].x) i--
    while (i < xList.length - 1 && tag >= xList[i + 1].x) i++

    state.lastX = i
    const seg = xList[i]

    if (tag >= seg.x && tag < seg.x + seg.len) {
      return { path, line: seg.z + (tag - seg.x), stale: false }
    }

    return { path, line: -1, stale: true }
  }

  edit(path, lo, hi, insertedLineCount) {
    const state = this.#states.get(path)
    if (!state) return []

    const delta = insertedLineCount - (hi - lo)
    const left = []
    const right = []
    const splits = new Map()
    const drops = new Set()

    for (let i = 0; i < state.zList.length; i++) {
      const seg = state.zList[i]
      const segEnd = seg.z + seg.len

      if (segEnd <= lo) {
        left.push(seg)
      } else if (seg.z >= hi) {
        seg.z += delta
        right.push(seg)
      } else if (seg.z < lo && segEnd > hi) {
        const rightSeg = { x: seg.x + (hi - seg.z), z: hi + delta, len: segEnd - hi }
        seg.len = lo - seg.z
        left.push(seg)
        right.push(rightSeg)
        splits.set(seg, rightSeg)
      } else if (seg.z < lo) {
        seg.len = lo - seg.z
        left.push(seg)
      } else if (segEnd > hi) {
        seg.x += (hi - seg.z)
        seg.len = segEnd - hi
        seg.z = hi + delta
        right.push(seg)
      } else {
        drops.add(seg)
      }
    }

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

    // X-order: one-pass merge. Base = survivors (in x-order). Inserts = splits + mid.
    const base = []
    const inserts = []
    for (let i = 0; i < state.xList.length; i++) {
      const seg = state.xList[i]
      if (drops.has(seg)) continue
      base.push(seg)
      const rightSeg = splits.get(seg)
      if (rightSeg) inserts.push(rightSeg)
    }
    if (midSeg) inserts.push(midSeg)
    // inserts 天然有序 — splits 来自 xList 遍历，midSeg 的 x 全局最大
    const merged = []
    let bi = 0, ii = 0
    while (bi < base.length && ii < inserts.length) {
      if (base[bi].x <= inserts[ii].x) merged.push(base[bi++])
      else merged.push(inserts[ii++])
    }
    while (bi < base.length) merged.push(base[bi++])
    while (ii < inserts.length) merged.push(inserts[ii++])
    state.xList = merged
    // Reset scan caches — zList/xList were rebuilt, cached indices are stale
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

  // Exposed for tagForLine fallback in text.js — paths are stable
  _getPathForTag(tag) { return this.#getPathForTag(tag) }
}

export const registry = new TagRegistry()

export class TagCursor {
  #zList
  #xList
  #zIndex = 0
  #xIndex = 0

  constructor(state) {
    this.#zList = state.zList
    this.#xList = state.xList
  }

  tagForLine(line) {
    if (this.#zList.length === 0) return undefined

    let i = Math.min(this.#zIndex, this.#zList.length - 1)

    while (i > 0 && line < this.#zList[i].z) i--
    while (i < this.#zList.length - 1 && line >= this.#zList[i + 1].z) i++

    this.#zIndex = i
    const seg = this.#zList[i]

    if (line >= seg.z && line < seg.z + seg.len) return seg.x + (line - seg.z)


    return undefined
  }
}
