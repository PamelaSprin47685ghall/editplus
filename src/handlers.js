import * as realIO from "./io.js"
import { registry } from "./registry.js"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"
import {
  alphaToNum, numToAlpha, readRange, validateBoundary, blockForLine, detectStructure,
  compilePattern, endingOf, failure, formatEditResult, formatSerialIndexes, formatSerialLines,
  resolveSerial, splitReplacement, stripAt, success, validateEditParams
} from "./text.js"

export const createHandlers = (deps = {}) => {
  const st = { io: deps.io ?? realIO, expand: deps.expandGlob ?? realIO.expandGlob, inspect: deps.inspectPath ?? realIO.inspectPath }
  return { read: p => handleRead(st, p), edit: p => handleEdit(st, p), grep: p => handleGrep(st, p) }
}

async function loadFile(state, path, cwd, failOnExt = false) {
  const file = await state.inspect(path, cwd)
  if (!file.ok) return file
  const data = await state.io.read(file.value).catch(e => failure(`Failed to read ${path}: ${e.message}`))
  if (!data.ok && data.error) return data
  if (registry.mtimeChanged(file.value, data.mtimeMs)) {
    registry.removeFile(file.value)
    if (failOnExt) return { ok: false, error: "File changed outside editplus. Re-read the full file before reading a serial range.", code: "EXTERNAL_CHANGE" }
  }
  registry.noteMtime(file.value, data.mtimeMs)
  return success({ path: file.value, ...data })
}

function renderFileSummary(fileValue, params = {}) {
  if (!registry.hasFile(fileValue.path)) registry.assign(fileValue.path, 0, fileValue.lines.length + 1)
  const getS = i => numToAlpha(registry.serialForLine(fileValue.path, i))
  if (!fileValue.lines.length) return `${getS(0)}|\n`
  const range = readRange(registry, params, fileValue)
  if (!range.ok) return null
  const lines = [...fileValue.lines, ""]
  const text = range.value.indexes
    ? formatSerialIndexes(getS, lines, [...range.value.indexes, fileValue.lines.length].sort((a, b) => a - b))
    : formatSerialLines(getS, lines, range.value.from, params.begin == null ? lines.length : range.value.to)
  return range.value.indexes ? `${range.value.heading}\n\n${text}\n\n${range.value.hint}` : text
}

async function appendSummary(state, path, errorMsg, projectDir, preloadedFileValue = null) {
  if (!path) return failure(errorMsg)
  let fileValue = preloadedFileValue
  if (!fileValue) {
    const file = await loadFile(state, stripAt(path), projectDir)
    if (!file.ok) return failure(errorMsg)
    fileValue = file.value
  }
  const summary = renderFileSummary(fileValue, { path }) || renderFileSummary(fileValue)
  return failure(`${errorMsg}\n\n--- Auto-attached current file summary ---\n${summary}`)
}

async function handleRead(state, params) {
  if (!params.path) {
    const s = params.begin ?? params.endInclusive ?? params.endExclusive
    if (s != null) {
      const num = typeof s === "string" ? alphaToNum(s) : s
      const res = registry.resolve(num)
      if (res && res.path) params.path = res.path
      else return failure("Invalid or expired serial number provided.")
    } else {
      params.path = "."
    }
  }
  
  let file = await loadFile(state, stripAt(params.path), params.projectDir, params.begin != null)
  if (!file.ok && file.isDirectory) return success(`$ du -hxd1\n${await state.io.generateFileListing(file.path)}\n`)

  let err = null
  if (!file.ok && file.code === "EXTERNAL_CHANGE") {
    err = file.error
    file = await loadFile(state, stripAt(params.path), params.projectDir)
  }
  if (!file.ok) return file
  if (!err) {
    const sum = renderFileSummary(file.value, params)
    if (sum !== null) return success(sum)
    err = readRange(registry, params, file.value).error
  }
  return appendSummary(state, params.path, err, params.projectDir)
}
function resolveEditBounds(params, projectDir, state) {
  const b = resolveSerial(registry, params.begin, "editing", "begin serial")
  let e = null
  if (params.endInclusive != null) {
    const res = resolveSerial(registry, params.endInclusive, "editing", "endInclusive serial")
    e = res.ok ? { ok: true, value: { path: res.value.path, line: res.value.line + 1 } } : res
  } else {
    e = resolveSerial(registry, params.endExclusive, "editing", "endExclusive serial")
  }
  
  if (!b.ok) return { err: b.path ? appendSummary(state, b.path, b.error, projectDir) : b }
  if (!e.ok) return { err: e.path ? appendSummary(state, e.path, e.error, projectDir) : e }
  const bd = validateBoundary(b.value, e.value)
  if (!bd.ok) return { err: appendSummary(state, b.value.path, bd.error, projectDir) }
  return { b: b.value, e: e.value }
}

async function handleEdit(state, params) {
  params = { ...params, begin: typeof params.begin === "string" ? alphaToNum(params.begin) : params.begin, endExclusive: typeof params.endExclusive === "string" ? alphaToNum(params.endExclusive) : params.endExclusive, endInclusive: typeof params.endInclusive === "string" ? alphaToNum(params.endInclusive) : params.endInclusive }
  const val = validateEditParams(params)
  if (!val.ok) return val
  
  const bounds = resolveEditBounds(params, params.projectDir, state)
  if (bounds.err) return bounds.err
  const { b, e } = bounds

  return state.io.withLock(b.path, async () => {
    const data = await state.io.read(b.path).catch(e => failure(`Failed to read: ${e.message}`))
    if (!data.ok && data.error) return data
    if (registry.mtimeChanged(b.path, data.mtimeMs)) {
      const structure = detectStructure(b.path, data.whole_content)
      return appendSummary(state, b.path, "File changed outside editplus.", params.projectDir, { path: b.path, mtimeMs: data.mtimeMs, lines: data.lines, whole_content: data.whole_content, structure })
    }

    const ins = splitReplacement(params.content, endingOf(data.lines[b.line]) || "\n")
    const newLines = [...data.lines.slice(0, b.line), ...ins, ...data.lines.slice(e.line)]
    await state.io.write(b.path, newLines)
    
    const upd = await state.io.read(b.path).catch(() => null)
    if (upd) registry.noteMtime(b.path, upd.mtimeMs)

    const ser = registry.edit(b.path, b.line, e.line, ins.length)
    const dispEnd = params.endExclusive != null ? params.endExclusive : registry.serialForLine(b.path, e.line)
    
    const diffLines = []
    const w = String(Math.max(data.lines.length, newLines.length)).length
    const pad = n => String(n).padStart(w, " ")
    const strip = s => s.replace(/\r?\n$/, "")
    
    const sc = Math.max(0, b.line - 4), ec = Math.min(data.lines.length, e.line + 4)
    if (sc > 0) diffLines.push(` ${" ".repeat(w)} ...`)
    for (let i = sc; i < b.line; i++) diffLines.push(` ${pad(i + 1)} ${strip(data.lines[i])}`)
    for (let i = b.line; i < e.line; i++) diffLines.push(`-${pad(i + 1)} ${strip(data.lines[i])}`)
    for (let i = 0; i < ins.length; i++) diffLines.push(`+${pad(b.line + i + 1)} ${strip(ins[i])}`)
    for (let i = e.line, o = b.line + ins.length; i < ec; i++, o++) diffLines.push(` ${pad(o + 1)} ${strip(data.lines[i])}`)
    if (ec < data.lines.length) diffLines.push(` ${" ".repeat(w)} ...`)

    return success({ isDetailed: true, text: formatEditResult(b.path, params, ser, dispEnd), details: { diff: diffLines.join("\n"), firstChangedLine: b.line + 1 } })
  })
}

async function handleGrep(state, params) {
  if (!params.path) return failure("path is required. Provide a file path or glob to search.")
  if (!params.pattern) return failure("pattern is required. Provide a JavaScript regular expression.")
  const matcher = compilePattern(params.pattern)
  if (!matcher.ok) return matcher
  const paths = await state.expand(stripAt(params.path), params.projectDir, params.includeIgnored)
  if (!paths.length) return failure(`No files matched ${params.path}.`)

  const processFile = async (path) => {
    const file = await loadFile(state, path, params.projectDir)
    if (!file.ok) return paths.length === 1 ? file : null
    const matches = []
    for (let i = 0; i < file.value.lines.length; i++) {
      matcher.value.lastIndex = 0
      if (matcher.value.test(file.value.lines[i])) matches.push(i)
    }
    if (matches.length) {
      if (!registry.hasFile(file.value.path)) registry.assign(file.value.path, 0, file.value.lines.length + 1)
      return { ...file.value, lines: [...file.value.lines, ""], matches, structure: detectStructure(file.value.path, file.value.whole_content) }
    }
    return null
  }

  const rawResults = await Promise.all(paths.map(processFile))
  if (paths.length === 1 && rawResults[0] && rawResults[0].ok === false) return rawResults[0]
  
  const results = rawResults.filter(r => r && r.ok !== false)

  if (!results.length) return success(`No matches for ${params.pattern}`)
  return success(results.map(r => {
    const getS = i => numToAlpha(registry.serialForLine(r.path, i))
    const s = new Set([0, r.lines.length - 1, ...(r.structure || [])])
    r.matches.forEach(m => { s.add(m); if(m>0)s.add(m-1); if(m<r.lines.length-1)s.add(m+1) })
    const sum = formatSerialIndexes(getS, r.lines, [...s].sort((a,b)=>a-b))
    
    const blocks = []
    r.matches.map(l => blockForLine(r.structure, l, r.lines.length)).sort((a,b)=>a[0]-b[0]).forEach(([f,t]) => {
      const last = blocks.at(-1)
      if (last && f <= last[1]) last[1] = Math.max(last[1], t)
      else blocks.push([f, t])
    })
    
    const rb = blocks.map(([f, t]) => `## Match block ${f + 1}-${t}\n\n\`\`\`\n${formatSerialLines(getS, r.lines, f, t)}\n\`\`\``)
    return paths.length === 1 ? [`# ${r.path}`, ...rb].join("\n\n") : [`# ${r.path}`, "## Summary", `\`\`\`\n${sum}\n\`\`\``, ...rb].join("\n\n")
  }).join("\n\n"))
}
