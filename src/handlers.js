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
    if (failOnExt) return failure("File changed outside editplus. Re-read the full file before reading a serial range.")
  }
  registry.noteMtime(file.value, data.mtimeMs)
  return success({ path: file.value, ...data })
}

function renderFileSummary(fileValue, params = {}) {
  const serials = registry.getSerials(fileValue.path, fileValue.lines.length)
  if (!fileValue.lines.length) return `${numToAlpha(serials[0])}|\n`
  const range = readRange(registry, params, fileValue)
  if (!range.ok) return null
  const lines = [...fileValue.lines, ""]
  const text = range.value.indexes
    ? formatSerialIndexes(serials, lines, [...range.value.indexes, fileValue.lines.length].sort((a, b) => a - b))
    : formatSerialLines(serials, lines, range.value.from, params.begin == null ? lines.length : range.value.to)
  return range.value.indexes ? `${range.value.heading}\n\n${text}\n\n${range.value.hint}` : text
}

async function appendSummary(state, path, errorMsg, projectDir) {
  if (!path) return failure(errorMsg)
  const file = await loadFile(state, stripAt(path), projectDir)
  if (!file.ok) return failure(errorMsg)
  const summary = renderFileSummary(file.value, { path }) || renderFileSummary(file.value)
  return failure(`${errorMsg}\n\n--- Auto-attached current file summary ---\n${summary}`)
}

async function handleRead(state, params) {
  if (!params.path) return failure("path is required. Provide a file path to read.")
  const rp = stripAt(params.path).startsWith("/") ? stripAt(params.path) : resolve(params.projectDir ?? process.cwd(), stripAt(params.path))
  const fileStat = await stat(rp).catch(() => null)
  if (fileStat?.isDirectory()) return success(`$ du -hxd1\n${await state.io.generateFileListing(rp)}\n`)

  let file = await loadFile(state, stripAt(params.path), params.projectDir, params.begin != null)
  let err = null
  if (!file.ok && file.error?.includes("File changed")) {
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
  let e = params.endInclusive != null 
    ? (res => res.ok ? { ok: true, value: { path: res.value.path, line: res.value.line + 1 } } : res)(resolveSerial(registry, params.endInclusive, "editing", "endInclusive serial"))
    : resolveSerial(registry, params.endExclusive, "editing", "endExclusive serial")
  
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
    if (registry.mtimeChanged(b.path, data.mtimeMs)) return appendSummary(state, b.path, "File changed outside editplus.", params.projectDir)

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
  if (!params.path) return failure("path is required. Provide a file path or glob to search."); if (!params.pattern) return failure("pattern is required. Provide a JavaScript regular expression.")
  const matcher = compilePattern(params.pattern)
  if (!matcher.ok) return matcher
  const paths = await state.expand(stripAt(params.path), params.projectDir)
  if (!paths.length) return failure(`No files matched ${params.path}.`)

  const results = []
  for (const path of paths) {
    const file = await loadFile(state, path, params.projectDir)
    if (!file.ok) { if (paths.length === 1) return file; continue }
    const matches = file.value.lines.flatMap((l, i) => { matcher.value.lastIndex = 0; return matcher.value.test(l) ? [i] : [] })
    if (matches.length) results.push({ ...file.value, lines: [...file.value.lines, ""], matches, serials: registry.getSerials(file.value.path, file.value.lines.length), structure: detectStructure(file.value.path, file.value.whole_content) })
  }

  if (!results.length) return success(`No matches for ${params.pattern}`)
  return success(results.map(r => {
    const s = new Set([0, r.lines.length - 1, ...(r.structure || [])])
    r.matches.forEach(m => { s.add(m); if(m>0)s.add(m-1); if(m<r.lines.length-1)s.add(m+1) })
    const sum = formatSerialIndexes(r.serials, r.lines, [...s].sort((a,b)=>a-b))
    
    const blocks = []
    r.matches.map(l => blockForLine(r.structure, l, r.lines.length)).sort((a,b)=>a[0]-b[0]).forEach(([f,t]) => {
      const last = blocks.at(-1)
      if (last && f <= last[1]) last[1] = Math.max(last[1], t)
      else blocks.push([f, t])
    })
    
    const rb = blocks.map(([f, t]) => `## Match block ${f + 1}-${t}\n\n\`\`\`\n${formatSerialLines(r.serials, r.lines, f, t)}\n\`\`\``)
    return paths.length === 1 ? [`# ${r.path}`, ...rb].join("\n\n") : [`# ${r.path}`, "## Summary", `\`\`\`\n${sum}\n\`\`\``, ...rb].join("\n\n")
  }).join("\n\n"))
}
