import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

const MAX_DEPTH = 10
const MAX_FILES = 10000

function sizeStr(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G"
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M"
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + "K" : bytes + "B"
}

async function dirSize(dir, depth = 0, state = { count: 0 }) {
  if (depth > MAX_DEPTH || state.count > MAX_FILES) return 0
  try {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    let sum = 0
    for (const item of items) {
      if (state.count > MAX_FILES) return sum
      const fp = join(dir, item.name)
      try {
        state.count++
        const st = await stat(fp).catch(() => null)
        if (st) sum += st.isDirectory() ? await dirSize(fp, depth + 1, state) : st.size
      } catch { /* ignore */ }
    }
    return sum
  } catch { return 0 }
}

export async function generateFileListing(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const listingPromises = entries.map(async item => {
      const fp = join(dir, item.name)
      try {
        const st = await stat(fp).catch(() => null)
        if (!st) return null
        const sz = st.isDirectory() ? await dirSize(fp) : st.size
        return { name: item.name, isDir: st.isDirectory(), sz }
      } catch { return null }
    })

    const results = (await Promise.all(listingPromises)).filter(Boolean)
    results.sort((a, b) => a.name.localeCompare(b.name))

    return results.map(r => {
      return `${sizeStr(r.sz).padStart(8)}  ${r.name}${r.isDir ? "/" : ""}`
    }).join("\n")
  } catch { return "" }
}
