import * as realIO from "./io.js"
import { alphaToNum, numToAlpha } from "./alpha.js"
import { expandGlob, inspectPath } from "./pathing.js"
import { readRange, validateBoundary } from "./ranges.js"
import { generateFileListing } from "./directory.js"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"
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

async function loadFile(state, path, cwd, options = {}) {
  const file = await state.inspect(path, cwd)
  if (!file.ok) return file

  const data = await state.io.read(file.value).catch(error => failure(`Failed to read ${path}: ${error.message}`))
  if (!data.ok && data.error) return data

  if (registry.mtimeChanged(file.value, data.mtimeMs)) {
    registry.removeFile(file.value)
    if (options.failOnExternalChange) return failure(options.externalChangeMessage)
  }
  registry.noteMtime(file.value, data.mtimeMs)
  return success({ path: file.value, ...data })
}

async function appendSummary(state, path, errorMsg, projectDir) {
  if (!path) return failure(errorMsg)
  const file = await loadFile(state, stripAt(path), projectDir, { failOnExternalChange: false })
  if (!file.ok) return failure(errorMsg)
  if (file.value.lines.length === 0) {
    const serials = registry.getSerials(file.value.path, 0)
    return failure(`${errorMsg}\n\n--- Auto-attached current file summary ---\n${numToAlpha(serials[0])}|\n`)
  }
  const fallbackRange = readRange(registry, { path }, file.value)
  const serials = registry.getSerials(file.value.path, file.value.lines.length)
  const lines = [...file.value.lines, ""]
  const text = fallbackRange.value.indexes
    ? formatSerialIndexes(serials, lines, [...fallbackRange.value.indexes, file.value.lines.length].sort((a, b) => a - b))
    : formatSerialLines(serials, lines, fallbackRange.value.from, lines.length)
  const fullRender = fallbackRange.value.indexes
    ? `${fallbackRange.value.heading}\n\n${text}\n\n${fallbackRange.value.hint}`
    : text
  return failure(`${errorMsg}\n\n--- Auto-attached current file summary ---\n${fullRender}`)
}

async function handleRead(state, params) {
  if (!params.path) return failure("path is required. Provide a file path to read.")

  const resolvedPath = stripAt(params.path).startsWith("/") ? stripAt(params.path) : resolve(params.projectDir ?? process.cwd(), stripAt(params.path))
  const fileStat = await stat(resolvedPath).catch(() => null)
  if (fileStat && fileStat.isDirectory()) {
    const listing = await generateFileListing(resolvedPath)
    return success(`$ du -hxd1\n${listing}\n`)
  }

  let file = await loadFile(state, stripAt(params.path), params.projectDir, {
    failOnExternalChange: params.begin != null,
    externalChangeMessage: "File changed outside editplus. Re-read the full file before reading a serial range.",
  })

  let rangeError = null

  if (!file.ok && file.error && file.error.includes("File changed outside editplus")) {
    rangeError = file.error
    file = await loadFile(state, stripAt(params.path), params.projectDir, { failOnExternalChange: false })
  }

  if (!file.ok) return file

  if (file.value.lines.length === 0) {
    const serials = registry.getSerials(file.value.path, 0); const serial = serials[0]
    const text = `${numToAlpha(serial)}|\n`
    if (rangeError) return failure(`${rangeError}\n\n--- Auto-attached current file summary ---\n${text}`)
    return success(text)
  }

  if (!rangeError) {
    const range = readRange(registry, params, file.value)
    if (range.ok) {
      const serials = registry.getSerials(file.value.path, file.value.lines.length)
      const lines = [...file.value.lines, ""]
      const text = range.value.indexes
        ? formatSerialIndexes(serials, lines, [...range.value.indexes, file.value.lines.length].sort((a, b) => a - b))
        : formatSerialLines(serials, lines, range.value.from, params.begin == null ? lines.length : range.value.to)
      return params.begin == null
        ? success(`${range.value.heading}\n\n${text}\n\n${range.value.hint}`)
        : success(text)
    }
    rangeError = range.error
  }

  return appendSummary(state, params.path, rangeError, params.projectDir)
}

async function handleEdit(state, params) {
  params = { ...params, begin: typeof params.begin === "string" ? alphaToNum(params.begin) : params.begin, endExclusive: typeof params.endExclusive === "string" ? alphaToNum(params.endExclusive) : params.endExclusive }
  const validation = validateEditParams(params)
  if (!validation.ok) return validation

  const begin = resolveSerial(registry, params.begin, "editing", "begin serial")
  const end = resolveSerial(registry, params.endExclusive, "editing", "endExclusive serial")
  if (!begin.ok) return begin.path ? appendSummary(state, begin.path, begin.error, params.projectDir) : begin
  if (!end.ok) return end.path ? appendSummary(state, end.path, end.error, params.projectDir) : end
  const boundary = validateBoundary(begin.value, end.value)
  if (!boundary.ok) return appendSummary(state, begin.value.path, boundary.error, params.projectDir)

  return state.io.withLock(begin.value.path, async () => {
    const prepared = await prepareEdit(state, params)
    if (!prepared.ok) {
      if (prepared.error && prepared.error.includes("File changed outside editplus")) {
        return appendSummary(state, begin.value.path, prepared.error, params.projectDir)
      }
      return prepared
    }
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

  const begin = resolveSerial(registry, params.begin, "editing", "begin serial")
  const end = resolveSerial(registry, params.endExclusive, "editing", "endExclusive serial")
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
