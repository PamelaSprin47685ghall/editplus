import { readFile, stat, writeFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { failure, success, splitLines } from "./text.js"

const execFileAsync = promisify(execFile)

const locks = new Map()

const MAX_READ_SIZE = 50 * 1024 * 1024
const DIR_SCAN_MAX_DEPTH = 10
const DIR_SCAN_MAX_FILES = 10000

export function withLock(path, fn, timeoutMs = 30000) {
  const prev = locks.get(path) || Promise.resolve()
  const p = prev.catch(() => {}).then(() => {
    return new Promise((resolve, reject) => {
      const ac = new AbortController()
      const timer = setTimeout(() => {
        ac.abort()
        reject(new Error(`Lock timeout on ${path}`))
      }, timeoutMs)
      Promise.resolve().then(() => fn(ac.signal)).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  })
  locks.set(path, p)
  p.finally(() => {
    if (locks.get(path) === p) locks.delete(path)
  })
  return p
}

export async function read(path) {
  const fileStat = await stat(path)
  if (fileStat.size > MAX_READ_SIZE) {
    return failure(`File too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB). Maximum read size is ${MAX_READ_SIZE / 1024 / 1024}MB.`)
  }
  const content = await readFile(path, "utf8")
  return success({ mtimeMs: fileStat.mtimeMs, whole_content: content, lines: splitLines(content) })
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
  try {
    const { stdout } = await execFileAsync("git", [...args, "--", input], { cwd: cwd ?? process.cwd(), encoding: "utf8" })
    return [...new Set(stdout.split('\0').filter(Boolean))].sort()
  } catch (err) {
    throw new Error("Git command failed.")
  }
}

const sizeStr = b => b >= 1e9 ? (b / 1e9).toFixed(1) + "G" : b >= 1e6 ? (b / 1e6).toFixed(1) + "M" : b >= 1024 ? (b / 1024).toFixed(1) + "K" : b + "B"

async function dirSize(dir, depth = 0, state = { count: 0 }) {
  if (depth > DIR_SCAN_MAX_DEPTH || state.count > DIR_SCAN_MAX_FILES) return 0
  try {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    let sum = 0
    for (const i of items) {
      if (state.count > DIR_SCAN_MAX_FILES) return sum
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
