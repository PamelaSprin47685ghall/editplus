export class LineRegistry {
  #nextSerial = 1
  #segments = []
  #mtimes = new Map()

  assign(path, line, count) {
    if (count <= 0) return []

    const start = this.#nextSerial
    this.#nextSerial += count
    this.#segments.push({ start, count, path, line, stale: [] })
    return Array.from({ length: count }, (_, index) => start + index)
  }

  resolve(serial) {
    for (let index = this.#segments.length - 1; index >= 0; index--) {
      const segment = this.#segments[index]
      const offset = serial - segment.start
      if (offset < 0 || offset >= segment.count) continue

      return {
        path: segment.path,
        line: segment.line + offset,
        stale: segment.stale.some(([from, to]) => offset >= from && offset < to),
      }
    }
  }

  noteMtime(path, mtimeMs) {
    this.#mtimes.set(path, mtimeMs)
  }

  mtimeChanged(path, mtimeMs) {
    const known = this.#mtimes.get(path)
    return known !== undefined && known !== mtimeMs
  }

  staleFile(path) {
    for (const segment of this.#segments) {
      if (segment.path === path) segment.stale.push([0, segment.count])
    }
  }

  edit(path, lo, hi, insertedLineCount) {
    this.#splitAt(path, lo)
    this.#splitAt(path, hi)
    this.#staleRange(path, lo, hi)
    this.#shiftFrom(path, hi, insertedLineCount - (hi - lo))
    return this.assign(path, lo, insertedLineCount)
  }

  reset() {
    this.#nextSerial = 1
    this.#segments = []
    this.#mtimes.clear()
  }

  #splitAt(path, line) {
    for (let index = 0; index < this.#segments.length; index++) {
      const segment = this.#segments[index]
      if (segment.path !== path || line <= segment.line || line >= segment.line + segment.count) continue

      const leftCount = line - segment.line
      const right = {
        start: segment.start + leftCount,
        count: segment.count - leftCount,
        path,
        line,
        stale: trimStale(segment.stale, leftCount, segment.count, -leftCount),
      }
      segment.count = leftCount
      segment.stale = trimStale(segment.stale, 0, leftCount, 0)
      this.#segments.splice(index + 1, 0, right)
      return
    }
  }

  #staleRange(path, lo, hi) {
    for (const segment of this.#segments) {
      if (segment.path !== path || segment.line < lo || segment.line >= hi) continue
      segment.stale.push([0, segment.count])
    }
  }

  #shiftFrom(path, line, delta) {
    if (delta === 0) return

    for (const segment of this.#segments) {
      if (segment.path === path && segment.line >= line) segment.line += delta
    }
  }
}

function trimStale(staleRanges, from, to, shift) {
  return staleRanges
    .map(([staleFrom, staleTo]) => [Math.max(staleFrom, from), Math.min(staleTo, to)])
    .filter(([staleFrom, staleTo]) => staleFrom < staleTo)
    .map(([staleFrom, staleTo]) => [staleFrom + shift, staleTo + shift])
}

export const registry = new LineRegistry()
