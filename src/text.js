import { splitLines } from "./io.js"

export function validateEditParams(params) {
  if (params.begin == null) return failure("begin is required. Use a serial from read or grep.")
  if (params.endExclusive == null) return failure("endExclusive is required. Use the serial where replacement should stop.")
  if (params.content == null) return failure("content is required. Use an empty string to delete.")
  return success(null)
}
export function resolveSerial(registry, serial) {
  const entry = registry.resolve(serial)
  if (!entry) return failure(`Serial ${serial} does not exist. Re-read the file and copy a current serial.`)
  return success(entry)
}

export function formatSerialLines(serials, lines, from, to) {
  const selected = serials.slice(from, to)
  const width = Math.max(...selected.map(serial => String(serial).length), 1)
  return selected.map((serial, index) => `${String(serial).padStart(width)}|${lines[from + index]}`).join("")
}

export function formatSerialIndexes(serials, lines, indexes) {
  const selected = indexes.map(index => serials[index])
  const width = Math.max(...selected.map(serial => String(serial).length), 1)
  return indexes.map(index => `${String(serials[index]).padStart(width)}|${lines[index]}`).join("")
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

export function formatEditResult(path, params, serials) {
  const serialText = serials.length ? ` New serials: ${serials.join(", ")}.` : ""
  return `Edited ${path} at [${params.begin}, ${params.endExclusive}).${serialText}`
}

export function success(value) {
  return { ok: true, value }
}

export function failure(error) {
  return { ok: false, error }
}
