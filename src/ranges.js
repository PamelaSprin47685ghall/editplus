import { detectStructure } from "./structure.js"
import { failure, resolveSerial, success } from "./text.js"

export function readRange(registry, params, file) {
  if (params.begin != null) return serialRange(registry, params, file.path)

  const structure = detectStructure(file.path, file.whole_content)
  return success({
    from: 0,
    to: file.lines.length,
    indexes: summaryIndexes(structure, file.lines.length),
    heading: `Summary for ${file.path}`,
    hint: readHint(structure),
  })
}

export function validateBoundary(begin, end) {
  if (begin.path !== end.path) return failure("Serial range spans multiple files. Re-read one file and use serials from that file only.")
  if (end.line < begin.line) return failure("Serial range is reversed. Use a begin serial before endExclusive.")
  return success(null)
}

function serialRange(registry, params, path) {
  const begin = resolveSerial(registry, params.begin)
  const end = params.endExclusive == null ? null : resolveSerial(registry, params.endExclusive)
  if (!begin.ok) return begin
  if (end && !end.ok) return end
  if (begin.value.path !== path || (end && end.value.path !== path)) return failure("Requested serial range does not belong to this path. Re-read the target file.")

  const to = end ? end.value.line : begin.value.line + 1
  if (to < begin.value.line) return failure("Serial range is reversed. Use a begin serial before endExclusive.")
  return success({ from: begin.value.line, to, heading: "", hint: "" })
}

function summaryIndexes(structure, totalLines) {
  if (!structure?.length || totalLines <= 80) return null

  const shown = new Set([0, 1, 2, totalLines - 2, totalLines - 1])
  for (const line of structure) shown.add(line)
  return [...shown].filter(line => line >= 0 && line < totalLines).sort((a, b) => a - b)
}

function readHint(structure) {
  if (!structure?.length) return "Use begin/endExclusive serials to read an exact range."
  return "This is a structural summary. Use begin/endExclusive serials to read an exact range."
}
