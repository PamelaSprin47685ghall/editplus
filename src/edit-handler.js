import { registry } from "./registry.js"
import { detectStructure } from "./structure.js"
import {
  tagToNum, numToTag, resolveTag, stripAt, success, failure, detailedSymbol, splitLines
} from "./text.js"
import { appendSummary } from "./read-handler.js"

export function prepareEditParams(raw) {
  const params = { ...raw, begin: typeof raw.begin === "string" ? tagToNum(raw.begin) : raw.begin, endExclusive: typeof raw.endExclusive === "string" ? tagToNum(raw.endExclusive) : raw.endExclusive, endInclusive: typeof raw.endInclusive === "string" ? tagToNum(raw.endInclusive) : raw.endInclusive }
  if (params.begin == null) return failure("begin is required.")
  if (params.endExclusive == null && params.endInclusive == null) return failure("Either endExclusive or endInclusive is required.")
  if (params.endExclusive != null && params.endInclusive != null) return failure("Provide either endExclusive or endInclusive, not both.")
  if (params.content == null) return failure("content is required.")
  return success(params)
}

function resolveEditBounds(registry, params, projectDir, state) {
  const b = resolveTag(registry, params.begin, "editing", "begin tag")
  let e = null
  if (params.endInclusive != null) {
    const res = resolveTag(registry, params.endInclusive, "editing", "endInclusive tag")
    e = res.ok ? { ok: true, value: { path: res.value.path, line: res.value.line + 1 } } : res
  } else {
    e = resolveTag(registry, params.endExclusive, "editing", "endExclusive tag")
  }
  if (!b.ok) return { err: b.path ? appendSummary(state, b.path, b.error, projectDir) : b }
  if (!e.ok) return { err: e.path ? appendSummary(state, e.path, e.error, projectDir) : e }
  if (b.value.path !== e.value.path) return { err: appendSummary(state, b.value.path, "Tag range spans multiple files.", projectDir) }
  if (e.value.line < b.value.line) return { err: appendSummary(state, b.value.path, "Tag range is reversed.", projectDir) }
  return { b: b.value, e: e.value }
}

function buildDiffOutput(data, newLines, b, e, ins) {
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
  return diffLines.join("\n")
}

async function applyEdit(state, signal, params, projectDir) {
  const bounds = resolveEditBounds(registry, params, projectDir, state)
  if (bounds.err) return bounds.err
  const { b, e } = bounds
  const result = await state.io.read(b.path).catch(e => failure(`Failed to read: ${e.message}`))
  if (!result.ok) return result
  const data = result.value
  if (registry.mtimeChanged(b.path, data.mtimeMs)) {
    const structure = detectStructure(b.path, data.whole_content)
    return appendSummary(state, b.path, "File changed outside editplus.", projectDir, { path: b.path, ...data, structure })
  }
  if (signal?.aborted) return failure("Operation aborted due to lock timeout.")
  let ins = []
  if (params.content) {
    const ending = data.lines[b.line]?.endsWith("\r\n") ? "\r\n" : data.lines[b.line]?.endsWith("\n") ? "\n" : data.lines[b.line]?.endsWith("\r") ? "\r" : ""
    ins = splitLines(/[\n\r]$/.test(params.content) ? params.content : params.content + (ending || "\n"))
  }
  const newLines = [...data.lines.slice(0, b.line), ...ins, ...data.lines.slice(e.line)]
  await state.io.write(b.path, newLines)
  const updResult = await state.io.read(b.path).catch(() => null)
  if (updResult?.ok) registry.noteMtime(b.path, updResult.value.mtimeMs)
  const tags = registry.edit(b.path, b.line, e.line, ins.length)
  const dispEnd = params.endExclusive != null ? params.endExclusive : registry.tagForLine(b.path, e.line)
  return success({ [detailedSymbol]: true, text: `Edited ${b.path} at [${numToTag(params.begin)}, ${numToTag(dispEnd)}).${tags.length ? ` New tags: ${tags.map(numToTag).join(", ")}.` : ""}`, details: { diff: buildDiffOutput(data, newLines, b, e, ins), firstChangedLine: b.line + 1 } })
}

export async function handleEdit(state, params) {
  const valid = prepareEditParams(params)
  if (!valid.ok) return valid
  const pathEntry = registry.resolve(valid.value.begin)
  if (!pathEntry || !pathEntry.path) {
    const bounds = resolveEditBounds(registry, params, params.projectDir, state)
    return bounds.err || failure("Edit failed: tag not found.")
  }
  return state.io.withLock(pathEntry.path, (signal) => applyEdit(state, signal, valid.value, params.projectDir))
}
