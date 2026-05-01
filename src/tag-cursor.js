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
