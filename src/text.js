import { splitLines } from "./io.js"
import { alphaToNum, numToAlpha } from "./alpha.js"

export function validateEditParams(params) {
  if (params.begin == null) return failure("begin is required. Use a serial from read or grep.")
  if (params.endExclusive == null && params.endInclusive == null) return failure("Either endExclusive or endInclusive is required.")
  if (params.endExclusive != null && params.endInclusive != null) return failure("Provide either endExclusive or endInclusive, not both.")
  if (params.content == null) return failure("content is required. Use an empty string to delete.")
  return success(null)
}

export function resolveSerial(registry, serial, action = "use", role = "serial") {
  const num = typeof serial === "string" ? (/[A-Z]/i.test(serial) ? alphaToNum(serial) : parseInt(serial, 10)) : serial
  const entry = registry.resolve(num)
  if (!entry) return { ok: false, error: `${role} ${serial} does not exist. Re-read the file and copy a current serial.` }
  if (entry.external) return { ok: false, error: `File changed outside editplus since ${role} ${serial} was generated. Re-read the file before ${action}.`, path: entry.path }
  if (entry.stale) return { ok: false, error: `${role} ${serial} is stale (line was edited or deleted). Re-read the file before ${action}.`, path: entry.path }
  return success(entry)
}

export function formatSerialLines(serials, lines, from, to) {
  const selected = serials.slice(from, to)
  const labels = selected.map(numToAlpha)
  const width = Math.max(...labels.map(s => s.length), 1)
  return labels.map((label, index) => {
    let text = lines[from + index]
    if (text && !text.endsWith("\n") && !text.endsWith("\r")) text += "\n"
    return `${label.padStart(width)}|${text}`
  }).join("")
}

export function formatSerialIndexes(serials, lines, indexes) {
  const labels = indexes.map(index => numToAlpha(serials[index]))
  const width = Math.max(...labels.map(s => s.length), 1)
  return indexes.map((index, i) => {
    let text = lines[index]
    if (text && !text.endsWith("\n") && !text.endsWith("\r")) text += "\n"
    return `${labels[i].padStart(width)}|${text}`
  }).join("")
}

export function splitReplacement(content, fallbackEnding) {
  if (content === "") return []
  return splitLines(/[\n\r]$/.test(content) ? content : content + fallbackEnding)
}

export function endingOf(line = "") {
  if (line.endsWith("\r\n")) return "\r\n"
  if (line.endsWith("\n")) return "\n"
  if (line.endsWith("\r")) return "\r"
  return ""
}

export function compilePattern(pattern) {
  const slashPattern = pattern.match(/^\/(.*)\/([dgimsuvy]*)$/)
  try {
    return success(slashPattern ? new RegExp(slashPattern[1], slashPattern[2]) : new RegExp(pattern))
  } catch (error) {
    return failure(`Invalid regular expression: ${error.message}. Fix pattern and grep again.`)
  }
}

export function stripAt(path) {
  return path.startsWith("@") ? path.slice(1) : path
}

export function formatEditResult(path, params, serials, displayEndExclusive = params.endExclusive) {
  const serialText = serials.length ? ` New serials: ${serials.map(numToAlpha).join(", ")}.` : ""
  return `Edited ${path} at [${numToAlpha(params.begin)}, ${numToAlpha(displayEndExclusive)}).${serialText}`
}

export function success(value) {
  return { ok: true, value }
}

export function failure(error) {
  return { ok: false, error }
}
