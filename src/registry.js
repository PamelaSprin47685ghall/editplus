const SENTINEL = 0 // Index of { x: Infinity, z: Infinity } to mark the end of arrays

export class LineRegistry {
  #nextSerial = 1
  #states = new Map()
  #mtimes = new Map()
  #allocations = []
  #minAllocatedSerial = 1
  #cleared = new Map()

  hasFile(path) { return this.#states.has(path) }

  removeFile(path) {
    this.#states.delete(path)
    this.#mtimes.delete(path)
    this.#cleared.set(path, this.#nextSerial)
    if (this.#cleared.size > 5000) {
      const keys = [...this.#cleared.keys()]
      for (let i = 0; i < Math.min(keys.length, 2500); i++)
        this.#cleared.delete(keys[i])
    }
  }

  assign(path, line, count) {
    if (count <= 0) return []
    let state = this.#states.get(path)
    if (!state) {
      state = { segs: [{ x: Infinity, z: Infinity }], byZ: [SENTINEL], byX: [SENTINEL] }
      this.#states.set(path, state)
    }

    const start = this.#nextSerial
    this.#nextSerial += count

    const newIdx = state.segs.length
    const seg = { x: start, z: line }
    state.segs.push(seg)
    this.#pushAlloc(start, count, path)

    state.byX = [...state.byX.filter(idx => idx !== SENTINEL), newIdx, SENTINEL]

    const newByZ = []
    let inserted = false
    for (const idx of state.byZ) {
      if (idx === SENTINEL) continue
      if (!inserted && state.segs[idx].z > seg.z) {
        newByZ.push(newIdx)
        inserted = true
      }
      newByZ.push(idx)
    }
    if (!inserted) newByZ.push(newIdx)
    newByZ.push(SENTINEL)
    state.byZ = newByZ

    return Array.from({ length: count }, (_, index) => start + index)
  }

  serialForLine(path, line) {
    const state = this.#states.get(path)
    if (!state) return undefined
    let zIdx = 0
    let nextZ = state.segs[state.byZ[zIdx + 1]].z
    while (line >= nextZ && zIdx < state.byZ.length - 2) {
      zIdx++
      nextZ = state.segs[state.byZ[zIdx + 1]].z
    }
    const seg = state.segs[state.byZ[zIdx]]
    return seg.x + (line - seg.z)
  }

  createCursor(path) {
    const state = this.#states.get(path)
    if (!state) return null
    return new SerialCursor(state)
  }

  #getPathForSerial(serial) {
    if (this.#allocations.length === 0) return undefined
    let low = 0
    let high = this.#allocations.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const alloc = this.#allocations[mid]
      if (serial < alloc.x) {
        high = mid - 1
      } else if (serial >= alloc.x + alloc.count) {
        low = mid + 1
      } else {
        return alloc.path
      }
    }
    return undefined
  }

  #pushAlloc(x, count, path) {
    this.#allocations.push({ x, count, path })
    if (this.#allocations.length > 20000) {
      this.#allocations = this.#allocations.slice(-10000)
      this.#minAllocatedSerial = this.#allocations[0].x
    }
  }

  resolve(serial) {
    const path = this.#getPathForSerial(serial)
    if (!path) return undefined

    if (this.#minAllocatedSerial > 1 && serial < this.#minAllocatedSerial) {
      return { expired: true, stale: true }
    }

    const clearedAt = this.#cleared.get(path)
    if (clearedAt && serial < clearedAt) {
      return { path, line: -1, stale: true, external: true }
    }

    const state = this.#states.get(path)
    if (!state) return undefined

    let prevIdx = -1
    for (const idx of state.byX) {
      if (state.segs[idx].x > serial) break
      prevIdx = idx
    }

    if (prevIdx !== -1) {
      const seg = state.segs[prevIdx]
      if (seg.x !== Infinity) {
        const line = seg.z + (serial - seg.x)
        const activeSerial = this.serialForLine(path, line)
        if (activeSerial !== serial) {
          return { path, line: -1, stale: true } // Stale serial rejected
        }
        return { path, line: Math.max(0, line), stale: false }
      }
    }

    return { path, line: -1, stale: true }
  }

  edit(path, lo, hi, insertedLineCount) {
    const state = this.#states.get(path)
    if (!state) return []

    const delta = insertedLineCount - (hi - lo)
    const left = []
    const right = []

    for (let j = 0; j < state.byZ.length - 1; j++) {
      const idx = state.byZ[j]
      const seg = state.segs[idx]
      const nextZ = state.segs[state.byZ[j + 1]].z
      const count = nextZ - seg.z

      if (seg.z + count <= lo) {
        left.push({ idx, x: seg.x, z: seg.z })
        continue
      }

      if (seg.z >= hi) {
        const newSeg = { x: seg.x, z: seg.z + delta }
        state.segs.push(newSeg)
        right.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
        continue
      }

      if (seg.z < lo) {
        left.push({ idx, x: seg.x, z: seg.z })
      }

      if (seg.z + count > hi) {
        const dropCount = hi - seg.z
        const newSeg = { x: seg.x + dropCount, z: hi + delta }
        state.segs.push(newSeg)
        right.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
      }
    }

    let newSerials = []
    const mid = []
    if (insertedLineCount > 0) {
      const start = this.#nextSerial
      this.#nextSerial += insertedLineCount
      const newSeg = { x: start, z: lo }
      state.segs.push(newSeg)
      this.#pushAlloc(start, insertedLineCount, path)
      mid.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
      newSerials = Array.from({ length: insertedLineCount }, (_, i) => start + i)
    }

    state.byZ = [
      ...left.map(s => s.idx),
      ...mid.map(s => s.idx),
      ...right.map(s => s.idx),
      SENTINEL,
    ]

    state.byX = [
      ...left.map(s => s.idx),
      ...right.map(s => s.idx),
      ...mid.map(s => s.idx),
    ]
    // byX must be sorted by seg.x ascending for resolve()'s linear scan.
    // left segs keep their original x (lowest serial range).
    // right segs: split ones get x = original.x + dropCount (middle range);
    //             wholly-after segs keep their original x, which was already
    //             above the edited range.
    // mid segs get brand-new serials from #nextSerial (highest range).
    // Therefore [left, right, mid] is naturally ordered by x.

    return newSerials
  }

  noteMtime(path, mtimeMs) { this.#mtimes.set(path, mtimeMs) }

  mtimeChanged(path, mtimeMs) { return this.#mtimes.has(path) && Math.abs(this.#mtimes.get(path) - mtimeMs) > 100 }

  reset() {
    this.#nextSerial = 1
    this.#states.clear()
    this.#mtimes.clear()
    this.#allocations = []
    this.#minAllocatedSerial = 1
    this.#cleared.clear()
  }
}

export const registry = new LineRegistry()

export class SerialCursor {
  #segs
  #byZ
  #zIdx = 0

  constructor(state) {
    this.#segs = state.segs
    this.#byZ = state.byZ
  }

  serialForLine(line) {
    let zIdx = this.#zIdx
    while (zIdx < this.#byZ.length - 2 && line >= this.#segs[this.#byZ[zIdx + 1]].z) zIdx++
    this.#zIdx = zIdx
    const seg = this.#segs[this.#byZ[zIdx]]
    return seg.x + (line - seg.z)
  }
}
