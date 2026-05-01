import { registry } from "./registry.js"
import { detectStructure } from "./structure.js"
import {
  tagToNum, numToTag, readRange, formatTag,
  resolveTag, stripAt, success, failure
} from "./text.js"

export async function loadFile(state, path, cwd, failOnExt = false) {
  const file = await state.inspect(path, cwd)
  if (!file.ok) return file
  const result = await state.io.read(file.value).catch(e => failure(`Failed to read ${path}: ${e.message}`))
  if (!result.ok) return result
  const { mtimeMs, whole_content, lines } = result.value
  if (registry.mtimeChanged(file.value, mtimeMs)) {
    registry.removeFile(file.value)
    if (failOnExt) return { ok: false, error: "File changed outside editplus. Re-read the full file before reading a tag range.", code: "EXTERNAL_CHANGE" }
  }
  registry.noteMtime(file.value, mtimeMs)
  const structure = detectStructure(file.value, whole_content, mtimeMs)
  return success({ path: file.value, mtimeMs, whole_content, lines, structure })
}

export function renderFileSummary(fileValue, params = {}) {
  if (!registry.hasFile(fileValue.path)) registry.assign(fileValue.path, 0, fileValue.lines.length + 1)
  const cursor = registry.createCursor(fileValue.path)
  const getS = i => numToTag(cursor ? cursor.tagForLine(i) : registry.tagForLine(fileValue.path, i))
  if (!fileValue.lines.length) return `${getS(0)}|\n`
  const range = readRange(registry, params, fileValue)
  if (!range.ok) return null
  const lines = [...fileValue.lines, ""]
  let idxes
  if (range.value.indexes) {
    idxes = [...range.value.indexes, fileValue.lines.length]
  } else {
    idxes = []
    for (let i = range.value.from; i < (params.begin == null ? lines.length : range.value.to); i++) idxes.push(i)
  }
  const text = formatTag(getS, lines, idxes)
  return range.value.indexes ? `${range.value.heading}\n\n${text}\n\n${range.value.hint}` : text
}

export async function appendSummary(state, path, errorMsg, projectDir, preloadedFileValue = null) {
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

export async function handleRead(state, params) {
  if (params.path == null) {
    const s = params.begin ?? params.endInclusive ?? params.endExclusive
    if (s != null) {
      const num = typeof s === "string" ? tagToNum(s) : s
      const res = registry.resolve(num)
      if (res && res.path) params.path = res.path
      else return failure("Invalid or expired tag provided.")
    } else {
      params.path = "."
    }
  }
  let file = await loadFile(state, stripAt(params.path), params.projectDir, params.begin != null)
  if (!file.ok && file.isDirectory) return success(`$ du -hxd1\n${await state.io.generateFileListing(file.path)}\n`)
  let err = null
  if (!file.ok && file.code === "EXTERNAL_CHANGE") { err = file.error; file = await loadFile(state, stripAt(params.path), params.projectDir) }
  if (!file.ok) return file
  if (!err) {
    const sum = renderFileSummary(file.value, params)
    if (sum !== null) return success(sum)
    err = readRange(registry, params, file.value).error
  }
  return appendSummary(state, params.path, err, params.projectDir)
}
