import { glob, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { failure, success } from "./text.js"

export async function inspectPath(input, cwd) {
  const path = input.startsWith("/") ? input : resolve(cwd ?? process.cwd(), input)
  const fileStat = await stat(path).catch(() => null)
  if (!fileStat) return failure(`${input} does not exist. Check the path and read again.`)
  if (!fileStat.isFile()) return failure(`${input} is not a regular file. Provide a file path.`)
  return success(path)
}

export async function expandGlob(input, cwd) {
  if (!/[*?[]/.test(input)) return [input]

  const paths = []
  for await (const path of glob(input, { cwd: cwd ?? process.cwd() })) paths.push(path)
  return [...new Set(paths)].sort()
}
