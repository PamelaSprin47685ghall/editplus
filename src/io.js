import { readFile, stat, writeFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { spawnSync } from "node:child_process"
import { failure, success } from "./text.js"

const locks = new Map()

export async function withLock(path, fn) {
  while (locks.has(path)) await locks.get(path).catch(() => {})
  const p = fn().finally(() => locks.get(path) === p && locks.delete(path))
  locks.set(path, p)
  return p
}

export async function read(path) {
  const [fileStat, content] = await Promise.all([stat(path), readFile(path, "utf8")])
  const lines = []
  for (let i = 0, s = 0; i < content.length; i++) {
    if (content[i] === "\n" || (content[i] === "\r" && content[i+1] !== "\n")) {
      lines.push(content.slice(s, i + 1))
      s = i + 1
    } else if (content[i] === "\r" && content[i+1] === "\n") {
      lines.push(content.slice(s, i + 2))
      i++
      s = i + 1
    }
    if (i === content.length - 1 && s < content.length) lines.push(content.slice(s))
  }
  return { mtimeMs: fileStat.mtimeMs, whole_content: content, lines }
}

export const write = (path, lines) => writeFile(path, lines.join(""), "utf8")

export async function inspectPath(input, cwd) {
  const path = input.startsWith("/") ? input : resolve(cwd ?? process.cwd(), input)
  const st = await stat(path).catch(() => null)
  if (!st) return failure(`${input} does not exist.`)
  if (!st.isFile()) return st.isDirectory() ? failure(`${input} is a directory.`, { isDirectory: true, path }) : failure(`${input} is not a regular file.`)
  return success(path)
}

export async function expandGlob(input, cwd, includeIgnored = false) {
  const args = ["ls-files", "-z", "--cached", "--others"]
  if (!includeIgnored) args.push("--exclude-standard")
  const res = spawnSync("git", [...args, "--", input], { cwd: cwd ?? process.cwd(), encoding: "utf8" })
  if (res.error || res.status !== 0) throw new Error("Git command failed.")
  return [...new Set(res.stdout.split('\0').filter(Boolean))].sort()
}

const sizeStr = b => b >= 1e9 ? (b / 1e9).toFixed(1) + "G" : b >= 1e6 ? (b / 1e6).toFixed(1) + "M" : b >= 1024 ? (b / 1024).toFixed(1) + "K" : b + "B"

async function dirSize(dir, depth = 0, state = { count: 0 }) {
  if (depth > 10 || state.count > 10000) return 0
  try {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    let sum = 0
    for (const i of items) {
      if (state.count > 10000) return sum
      const fp = join(dir, i.name)
      state.count++
      const st = await stat(fp).catch(() => null)
      if (st) sum += st.isDirectory() ? await dirSize(fp, depth + 1, state) : st.size
    }
    return sum
  } catch { return 0 }
}

export async function generateFileListing(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const results = (await Promise.all(entries.map(async i => {
      const fp = join(dir, i.name)
      const st = await stat(fp).catch(() => null)
      if (!st) return null
      return { name: i.name, isDir: st.isDirectory(), sz: st.isDirectory() ? await dirSize(fp) : st.size }
    }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
    return results.map(r => `${sizeStr(r.sz).padStart(8)}  ${r.name}${r.isDir ? "/" : ""}`).join("\n")
  } catch { return "" }
}
