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
  const isGitRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: cwd ?? process.cwd() }).status === 0
  
  if (isGitRepo) {
    const args = ["ls-files", "-z", "--cached", "--others"]
    if (!includeIgnored) args.push("--exclude-standard")
    args.push("--", input)
    
    const result = spawnSync("git", args, { cwd: cwd ?? process.cwd(), encoding: "utf8" })
    if (result.status === 0) {
      const paths = result.stdout.split('\0').filter(Boolean)
      if (paths.length > 0) return [...new Set(paths)].sort()
    }
  }

  // Fallback to node glob for non-git repos or empty git results
  const { glob } = await import("node:fs/promises")
  let pattern = input
  if (!/[*?[]/.test(pattern)) {
    const fullPath = pattern.startsWith("/") ? pattern : resolve(cwd ?? process.cwd(), pattern)
    const st = await stat(fullPath).catch(() => null)
    if (st && st.isDirectory()) {
      pattern = pattern.replace(/\/$/, "") + "/**/*"
    } else {
      return [pattern]
    }
  }

  const paths = []
  for await (const path of glob(pattern, { cwd: cwd ?? process.cwd() })) paths.push(path)
  return [...new Set(paths)].sort()
}
