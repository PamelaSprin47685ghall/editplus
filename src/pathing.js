import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { failure, success } from "./text.js"

export async function inspectPath(input, cwd) {
  const path = input.startsWith("/") ? input : resolve(cwd ?? process.cwd(), input)
  const fileStat = await stat(path).catch(() => null)
  if (!fileStat) return failure(`${input} does not exist. Check the path and read again.`)
  if (!fileStat.isFile()) {
    if (fileStat.isDirectory()) return failure(`${input} is a directory. Provide a file path.`, { isDirectory: true, path })
    return failure(`${input} is not a regular file. Provide a file path.`)
  }
  return success(path)
}

export async function expandGlob(input, cwd, includeIgnored = false) {
  const execCwd = cwd ?? process.cwd()
  const args = ["ls-files", "-z", "--cached", "--others"]
  if (!includeIgnored) args.push("--exclude-standard")
  args.push("--", input)

  const result = spawnSync("git", args, { cwd: execCwd, encoding: "utf8" })
  if (result.error || result.status !== 0) {
    throw new Error("grep tool requires a git repository. Git command failed: " + (result.stderr || result.error?.message || "Unknown error"))
  }

  const paths = result.stdout.split('\0').filter(Boolean)
  return [...new Set(paths)].sort()
}
