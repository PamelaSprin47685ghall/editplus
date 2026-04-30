import * as realIO from "./io.js"
import { alphaToNum, numToAlpha } from "./alpha.js"
import { expandGlob, inspectPath } from "./pathing.js"
import { readRange, validateBoundary } from "./ranges.js"
import { registry } from "./registry.js"
import { blockForLine, detectStructure } from "./structure.js"
import {
  compilePattern,
  endingOf,
  failure,
  formatEditResult,
  formatSerialIndexes,
  formatSerialLines,
  resolveSerial,
  splitReplacement,
  stripAt,
  success,
  validateEditParams,
} from "./text.js"

export function createHandlers(deps = {}) {
  const state = {
    io: deps.io ?? realIO,
    expand: deps.expandGlob ?? expandGlob,
    inspect: deps.inspectPath ?? inspectPath,
  }

  return {
    read: params => handleRead(state, params),
    edit: params => handleEdit(state, params),
    grep: params => handleGrep(state, params),
  }
}

async function loadFile(state, path, cwd) {
  const file = await state.inspect(path, cwd)
  if (!file.ok) return file

  const data = await state.io.read(file.value).catch(error => failure(`Failed to read ${path}: ${error.message}`))
  if (!data.ok && data.error) return data

  if (registry.mtimeChanged(file.value, data.mtimeMs)) registry.removeFile(file.value)
  registry.noteMtime(file.value, data.mtimeMs)
  return success({ path: file.value, ...data })
}

async function handleRead(state, params) {
  if (!params.path) return failure("path is required. Provide a file path to read.")

  const file = await loadFile(state, stripAt(params.path), params.projectDir)
  if (!file.ok) return file
  if (file.value.lines.length === 0) {
    const serials = registry.getSerials(file.value.path, 0); const serial = serials[0]
    return success(`${numToAlpha(serial)}|\n`)
  }

  const range = readRange(registry, params, file.value)
  if (!range.ok) return range

  // Assign N+1 serials: N for real lines + 1 end sentinel (line = file length)
  const serials = registry.getSerials(file.value.path, file.value.lines.length)
  const lines = [...file.value.lines, ""]
  const text = range.value.indexes
    ? formatSerialIndexes(serials, lines, [...range.value.indexes, file.value.lines.length].sort((a, b) => a - b))
    : formatSerialLines(serials, lines, range.value.from, params.begin == null ? lines.length : range.value.to)
  return params.begin == null
    ? success(`${range.value.heading}\n\n${text}\n\n${range.value.hint}`)
    : success(text)
}

async function handleEdit(state, params) {
  params = { ...params, begin: typeof params.begin === "string" ? alphaToNum(params.begin) : params.begin, endExclusive: typeof params.endExclusive === "string" ? alphaToNum(params.endExclusive) : params.endExclusive }
  const validation = validateEditParams(params)
  if (!validation.ok) return validation

  const begin = resolveSerial(registry, params.begin)
  const end = resolveSerial(registry, params.endExclusive)
  if (!begin.ok) return begin
  if (!end.ok) return end
  const boundary = validateBoundary(begin.value, end.value)
  if (!boundary.ok) return boundary

  return state.io.withLock(begin.value.path, async () => {
    const prepared = await prepareEdit(state, params)
    if (!prepared.ok) return prepared

    await state.io.write(prepared.value.path, prepared.value.lines)
    const updated = await state.io.read(prepared.value.path)
      .catch(() => null)
    if (updated) registry.noteMtime(prepared.value.path, updated.mtimeMs)

    const newSerials = registry.edit(
      prepared.value.path,
      prepared.value.begin.line,
      prepared.value.end.line,
      prepared.value.insertedLines.length,
    )
    return success(formatEditResult(prepared.value.path, params, newSerials))
  })
}

async function prepareEdit(state, params) {
  const validation = validateEditParams(params)
  if (!validation.ok) return validation

  const begin = resolveSerial(registry, params.begin)
  const end = resolveSerial(registry, params.endExclusive)
  if (!begin.ok) return begin
  if (!end.ok) return end
  const boundary = validateBoundary(begin.value, end.value)
  if (!boundary.ok) return boundary

  const data = await state.io.read(begin.value.path).catch(error => failure(`Failed to read before edit: ${error.message}`))
  if (!data.ok && data.error) return data
  if (registry.mtimeChanged(begin.value.path, data.mtimeMs)) return failure("File changed outside editplus. Re-read it before editing.")

  const insertedLines = splitReplacement(params.content, endingOf(data.lines[begin.value.line]) || "\n")
  return success({
    path: begin.value.path,
    begin: begin.value,
    end: end.value,
    insertedLines,
    lines: [...data.lines.slice(0, begin.value.line), ...insertedLines, ...data.lines.slice(end.value.line)],
  })
}

async function handleGrep(state, params) {
  const setup = await prepareGrep(state, params)
  if (!setup.ok) return setup

  const results = []
  for (const path of setup.value.paths) {
    const result = await grepFile(state, path, params.projectDir, setup.value.matcher)
    if (result.ok && result.value) results.push(result.value)
    if (!result.ok && setup.value.paths.length === 1) return result
  }

  if (results.length === 0) return success(`No matches for ${params.pattern}`)
  return success(results.map(renderGrepFile).join("\n\n"))
}

async function prepareGrep(state, params) {
  if (!params.path) return failure("path is required. Provide a file path or glob to search.")
  if (!params.pattern) return failure("pattern is required. Provide a JavaScript regular expression.")

  const matcher = compilePattern(params.pattern)
  if (!matcher.ok) return matcher

  const paths = await state.expand(stripAt(params.path), params.projectDir)
  if (paths.length === 0) return failure(`No files matched ${params.path}. Check the path or glob.`)
  return success({ matcher: matcher.value, paths })
}

async function grepFile(state, path, cwd, matcher) {
  const file = await loadFile(state, path, cwd)
  if (!file.ok) return file

  const matches = file.value.lines.flatMap((line, index) => {
    matcher.lastIndex = 0
    return matcher.test(line) ? [index] : []
  })
  if (matches.length === 0) return success(null)

  const serials = registry.getSerials(file.value.path, file.value.lines.length)
  return success({ ...file.value, lines: [...file.value.lines, ""], matches, serials, structure: detectStructure(file.value.path, file.value.whole_content) })
}

function renderGrepFile(result) {
  const { serials, lines, matches, structure } = result
  const indexes = buildSummaryIndexes(lines.length, matches, structure)
  const summary = formatSerialIndexes(serials, lines, indexes)
  const blocks = mergeBlocks(matches.map(line => blockForLine(structure, line, lines.length)))
  const renderedBlocks = blocks.map(([from, to]) => renderMatchBlock(result, from, to))
  return [`# ${result.path}`, "## Summary", `\`\`\`\n${summary}\n\`\`\``, ...renderedBlocks].join("\n\n")
}

function buildSummaryIndexes(totalLines, matches, structure) {
  const set = new Set()
  set.add(0)
  set.add(totalLines - 1)
  if (structure) for (const s of structure) set.add(s)
  for (const m of matches) {
    set.add(m)
    if (m > 0) set.add(m - 1)
    if (m < totalLines - 1) set.add(m + 1)
  }
  return [...set].sort((a, b) => a - b)
}

function renderMatchBlock(result, from, to) {
  return `## Match block ${from + 1}-${to}\n\n\`\`\`\n${formatSerialLines(result.serials, result.lines, from, to)}\n\`\`\``
}

function mergeBlocks(blocks) {
  const merged = []
  for (const [from, to] of blocks.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}
