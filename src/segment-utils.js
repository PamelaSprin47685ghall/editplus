export function classifyZSegments(zList, lo, hi, delta) {
  const left = [], right = []
  const splits = new Map()
  const drops = new Set()

  for (const seg of zList) {
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
  return { left, right, splits, drops }
}

export function mergeXList(xList, drops, splits, midSeg) {
  const base = []
  const inserts = []
  for (const seg of xList) {
    if (drops.has(seg)) continue
    base.push(seg)
    const rightSeg = splits.get(seg)
    if (rightSeg) inserts.push(rightSeg)
  }
  if (midSeg) inserts.push(midSeg)

  const merged = []
  let bi = 0, ii = 0
  while (bi < base.length && ii < inserts.length) {
    if (base[bi].x <= inserts[ii].x) merged.push(base[bi++])
    else merged.push(inserts[ii++])
  }
  while (bi < base.length) merged.push(base[bi++])
  while (ii < inserts.length) merged.push(inserts[ii++])
  return merged
}
