export class LineRegistry {
  #nextSerial = 1
  #states = new Map()
  #mtimes = new Map()
  #allocations = []
  #cleared = new Map()

  hasFile(path) { return this.#states.has(path) }

  removeFile(path) {
    this.#states.delete(path)
    this.#mtimes.delete(path)
    this.#cleared.set(path, this.#nextSerial)
  }

  assign(path, line, count) {
    if (count <= 0) return []
    let state = this.#states.get(path)
    if (!state) {
      state = { segs: [{ x: Infinity, z: Infinity }], byZ: [0], byX: [0] }
      this.#states.set(path, state)
    }

    const start = this.#nextSerial
    this.#nextSerial += count

    const newIdx = state.segs.length
    const seg = { x: start, z: line }
    state.segs.push(seg)
    this.#allocations.push({ x: start, count, path })

    state.byX.push(newIdx)
    state.byX.sort((a, b) => state.segs[a].x - state.segs[b].x)

    state.byZ = state.byZ.filter(idx => idx !== 0)
    state.byZ.push(newIdx)
    state.byZ.sort((a, b) => state.segs[a].z - state.segs[b].z)
    state.byZ.push(0)

    return Array.from({ length: count }, (_, index) => start + index)
  }

  getSerials(path, maxLine) {
    if (!this.#states.has(path)) {
      this.assign(path, 0, maxLine + 1)
    }
    const state = this.#states.get(path)
    const serials = new Array(maxLine + 1)
    let zIdx = 0
    let nextZ = state.segs[state.byZ[zIdx + 1]].z

    for (let L = 0; L <= maxLine; L++) {
      while (L >= nextZ) {
        zIdx++
        nextZ = state.segs[state.byZ[zIdx + 1]].z
      }
      const seg = state.segs[state.byZ[zIdx]]
      serials[L] = seg.x + (L - seg.z)
    }
    return serials
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

  #getPathForSerial(serial) {
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

  resolve(serial) {
    const path = this.#getPathForSerial(serial)
    if (!path) return undefined

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
    const activeSegs = []

    for (let j = 0; j < state.byZ.length - 1; j++) {
      const idx = state.byZ[j]
      const seg = state.segs[idx]
      const nextZ = state.segs[state.byZ[j + 1]].z
      const count = nextZ - seg.z

      if (seg.z + count <= lo) {
        activeSegs.push({ idx, x: seg.x, z: seg.z })
        continue
      }

      if (seg.z >= hi) {
        const newSeg = { x: seg.x, z: seg.z + delta }
        state.segs.push(newSeg)
        activeSegs.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
        continue
      }

      if (seg.z < lo) {
        activeSegs.push({ idx, x: seg.x, z: seg.z })
      }

      if (seg.z + count > hi) {
        const dropCount = hi - seg.z
        const newSeg = { x: seg.x + dropCount, z: hi + delta }
        state.segs.push(newSeg)
        activeSegs.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
      }
    }

    let newSerials = []
    if (insertedLineCount > 0) {
      const start = this.#nextSerial
      this.#nextSerial += insertedLineCount
      const newSeg = { x: start, z: lo }
      state.segs.push(newSeg)
      this.#allocations.push({ x: start, count: insertedLineCount, path })
      activeSegs.push({ idx: state.segs.length - 1, x: newSeg.x, z: newSeg.z })
      newSerials = Array.from({ length: insertedLineCount }, (_, i) => start + i)
    }

    state.byZ = activeSegs.slice().sort((a, b) => a.z - b.z).map(s => s.idx)
    state.byZ.push(0)

    state.byX = activeSegs.slice().sort((a, b) => a.x - b.x).map(s => s.idx)

    return newSerials
  }

  noteMtime(path, mtimeMs) {
    this.#mtimes.set(path, mtimeMs)
  }

  mtimeChanged(path, mtimeMs) {
    const known = this.#mtimes.get(path)
    return known !== undefined && known !== mtimeMs
  }

  reset() {
    this.#nextSerial = 1
    this.#states.clear()
    this.#mtimes.clear()
    this.#allocations = []
    this.#cleared.clear()
  }
}

export const registry = new LineRegistry()
