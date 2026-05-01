import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { createHandlers } from "../src/handlers.js"
import { registry } from "../src/registry.js"

export const handlers = createHandlers()
const tempDirs = []

export function resetTestState() {
  registry.reset()
}

export async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
}

export async function fixture(content, filename = "sample.js") {
  const dir = await mkdtemp(join(tmpdir(), "editplus-"))
  tempDirs.push(dir)
  spawnSync("git", ["init"], { cwd: dir })
  const file = join(dir, filename)
  await writeFile(file, content, "utf8")
  return { dir, file }
}

export function tagsOf(text) {
  if (!text) return []
  return [...text.matchAll(/([A-Z]+)\|/g)].map(m => m[1])
}
