import { readFile, stat, writeFile } from "node:fs/promises"

const locks = new Map()

export async function withLock(path, fn) {
  while (locks.has(path)) {
    await locks.get(path).catch(() => {})
  }
  const promise = fn().finally(() => {
    if (locks.get(path) === promise) locks.delete(path)
  })
  locks.set(path, promise)
  return promise
}

export async function read(path) {
  const [fileStat, whole_content] = await Promise.all([
    stat(path),
    readFile(path, "utf8"),
  ])

  return {
    mtimeMs: fileStat.mtimeMs,
    whole_content,
    lines: splitLines(whole_content),
  }
}

export async function write(path, lines) {
  await writeFile(path, lines.join(""), "utf8")
}

export function splitLines(text) {
  const lines = []
  let start = 0

  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1))
      start = index + 1
      continue
    }

    if (text[index] !== "\r") continue

    if (text[index + 1] === "\n") {
      lines.push(text.slice(start, index + 2))
      index++
    } else {
      lines.push(text.slice(start, index + 1))
    }
    start = index + 1
  }

  if (start < text.length) lines.push(text.slice(start))
  return lines
}
