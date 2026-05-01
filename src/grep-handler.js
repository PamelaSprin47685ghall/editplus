import { registry } from "./registry.js"
import { detectStructure } from "./structure.js"
import {
  numToTag, formatTag, stripAt, success, failure
} from "./text.js"
import { loadFile } from "./read-handler.js"

const UNSAFE_REGEX = /\(\s*[^)]*(?:\[[^\]]*\]|[^)])*\)\s*[+*{]/
const MAX_PATTERN_LEN = 512

function formatGrepResults(results, paths) {
  return results.map(r => {
    const cursor = registry.createCursor(r.path)
    const getS = i => numToTag(cursor ? cursor.tagForLine(i) : registry.tagForLine(r.path, i))
    const s = new Set([0, r.lines.length - 1, ...(r.structure || [])])
    r.matches.forEach(m => { s.add(m); if (m > 0) s.add(m - 1); if (m < r.lines.length - 1) s.add(m + 1) })
    const sum = formatTag(getS, r.lines, [...s].sort((a, b) => a - b))

    const blocks = []
    r.matches.map(l => {
      if (!r.structure?.length) return [0, r.lines.length]
      let start = 0
      for (const c of r.structure) { if (c > l) break; start = c }
      return [start, r.structure.find(c => c > l) ?? r.lines.length]
    }).forEach(([f, t]) => {
      const last = blocks.at(-1)
      if (last && f <= last[1]) last[1] = Math.max(last[1], t)
      else blocks.push([f, t])
    })
    const rb = blocks.map(([f, t]) => {
      const idxes = []
      for (let i = f; i < t; i++) idxes.push(i)
      return `## Match block ${f + 1}-${t}\n\n\`\`\`\n${formatTag(getS, r.lines, idxes)}\n\`\`\``
    })
    return paths.length === 1 ? [`# ${r.path}`, ...rb].join("\n\n") : [`# ${r.path}`, "## Summary", `\`\`\`\n${sum}\n\`\`\``, ...rb].join("\n\n")
  }).join("\n\n")
}

async function processFile(state, path, projectDir, matcher) {
  const file = await loadFile(state, path, projectDir)
  if (!file.ok) return null
  const matches = []
  for (let i = 0; i < file.value.lines.length; i++) {
    matcher.lastIndex = 0
    if (matcher.test(file.value.lines[i])) matches.push(i)
  }
  if (!matches.length) return null
  if (!registry.hasFile(file.value.path)) registry.assign(file.value.path, 0, file.value.lines.length + 1)
  return { ...file.value, lines: [...file.value.lines, ""], matches, structure: detectStructure(file.value.path, file.value.whole_content) }
}

export async function handleGrep(state, params) {
  if (!params.path) return failure("path is required. Provide a file path or glob to search.")
  if (!params.pattern) return failure("pattern is required. Provide a JavaScript regular expression.")

  let matcher
  try {
    if (params.pattern.length > MAX_PATTERN_LEN) return failure(`Pattern too long (${params.pattern.length} > ${MAX_PATTERN_LEN}). Shorten pattern and grep again.`)
    if (UNSAFE_REGEX.test(params.pattern)) return failure("Pattern contains nested quantifiers (e.g. (...)+) which can cause catastrophic backtracking. Simplify pattern and grep again.")
    const m = params.pattern.match(/^\/(.*)\/([a-z]*)$/)
    matcher = m ? new RegExp(m[1], m[2]) : new RegExp(params.pattern)
  } catch (e) { return failure(`Invalid regular expression: ${e.message}. Fix pattern and grep again.`) }

  const paths = await state.expand(stripAt(params.path), params.projectDir, params.includeIgnored)
  if (!paths.length) return failure(`No files matched ${params.path}.`)
  const results = (await Promise.all(paths.map(p => processFile(state, p, params.projectDir, matcher)))).filter(Boolean)
  if (!results.length) return success(`No matches for ${params.pattern}`)
  return success(formatGrepResults(results, paths))
}
