import languagePack from "@kreuzberg/tree-sitter-language-pack"

export function numToAlpha(n) {
  let res = ""
  for (; n > 0; n = Math.floor((n - 1) / 52)) {
    const off = (n - 1) % 52
    res = String.fromCharCode(off < 26 ? 65 + off : 71 + off) + res
  }
  return res
}

export function alphaToNum(s) {
  let res = 0
  for (const c of s) {
    const code = c.charCodeAt(0)
    if (code >= 65 && code <= 90) res = res * 52 + code - 64
    else if (code >= 97 && code <= 122) res = res * 52 + code - 70
    else return NaN
  }
  return res
}

export function detectStructure(path, content) {
  try {
    const lang = languagePack.detectLanguageFromPath(path) ?? languagePack.detectLanguageFromContent(content)
    if (!lang) return null
    const res = languagePack.process(content, { language: lang })
    const lines = res?.structure?.map(i => i.span?.startLine).filter(Number.isInteger)
    return lines?.length ? [...new Set(lines)].sort((a, b) => a - b) : null
  } catch (err) {
    process.stderr.write(`Warning: Failed to detect structure for ${path} (${err.message})\n`)
    return null
  }
}

export function blockForLine(structure, line, total) {
  if (!structure?.length) return [0, total]
  let start = 0
  for (const c of structure) {
    if (c > line) break
    start = c
  }
  return [start, structure.find(c => c > line) ?? total]
}

export function readRange(registry, params, file) {
  if (params.begin != null) {
    const begin = resolveSerial(registry, params.begin, "reading", "begin serial")
    let end = null
    if (params.endInclusive != null) {
      const e = resolveSerial(registry, params.endInclusive, "reading", "endInclusive serial")
      end = e.ok ? { ok: true, value: { path: e.value.path, line: e.value.line + 1 } } : e
    } else if (params.endExclusive != null) {
      end = resolveSerial(registry, params.endExclusive, "reading", "endExclusive serial")
    }
    
    if (!begin.ok) return begin
    if (end && !end.ok) return end
    if (begin.value.path !== file.path || (end && end.value.path !== file.path)) return failure("Requested serial range does not belong to this path.")
    if (end && end.value.line < begin.value.line) return failure("Serial range is reversed.")
    
    return success({ from: begin.value.line, to: end ? end.value.line : begin.value.line + 1, heading: "", hint: "" })
  }

  const struct = detectStructure(file.path, file.whole_content)
  const shown = new Set([0, 1, 2, file.lines.length - 2, file.lines.length - 1])
  if (struct) struct.forEach(l => shown.add(l))
  
  return success({
    from: 0, to: file.lines.length,
    indexes: (!struct?.length || file.lines.length <= 80) ? null : [...shown].filter(l => l >= 0 && l < file.lines.length).sort((a, b) => a - b),
    heading: `Summary for ${file.path}`,
    hint: struct?.length ? "This is a structural summary. Use begin/endExclusive serials to read an exact range." : "Use begin/endExclusive serials to read an exact range.",
  })
}

export function validateBoundary(begin, end) {
  if (begin.path !== end.path) return failure("Serial range spans multiple files.")
  if (end.line < begin.line) return failure("Serial range is reversed.")
  return success(null)
}

export function validateEditParams(params) {
  if (params.begin == null) return failure("begin is required.")
  if (params.endExclusive == null && params.endInclusive == null) return failure("Either endExclusive or endInclusive is required.")
  if (params.endExclusive != null && params.endInclusive != null) return failure("Provide either endExclusive or endInclusive, not both.")
  if (params.content == null) return failure("content is required.")
  return success(null)
}

export function resolveSerial(registry, serial, action = "use", role = "serial") {
  if (typeof serial === "string" && /^[0-9]+$/.test(serial.trim())) return failure(`Raw numeric serials are not allowed.`)
  const num = typeof serial === "string" ? alphaToNum(serial) : serial
  const disp = typeof serial === "string" ? serial : numToAlpha(serial)
  const entry = registry.resolve(num)
  if (!entry) return failure(`${role} ${disp} does not exist. Re-read the file and copy a current serial.`)
  if (entry.expired) return failure(`${role} ${disp} has expired (allocations exceeded). Re-read the file and copy a current serial.`)
  if (entry.external) return { ok: false, error: `File changed outside editplus since ${role} ${disp} was generated. Re-read the file before ${action}.`, path: entry.path }
  if (entry.stale) return { ok: false, error: `${role} ${disp} is stale (line was edited or deleted). Re-read the file before ${action}.`, path: entry.path }
  return success(entry)
}

function formatSerial(getSerial, lines, indexes) {
  const labels = indexes.map(getSerial)
  const width = Math.max(...labels.map(s => s.length), 1)
  return indexes.map((idx, i) => {
    const line = lines[idx]
    const suffix = line?.endsWith('\n') || line?.endsWith('\r') ? line : (line || '') + '\n'
    return `${labels[i].padStart(width)}|${suffix}`
  }).join("")
}

export function formatSerialLines(getSerial, lines, from, to) {
  const indexes = []
  for (let i = from; i < to; i++) indexes.push(i)
  return formatSerial(getSerial, lines, indexes)
}

export function formatSerialIndexes(getSerial, lines, indexes) {
  return formatSerial(getSerial, lines, indexes)
}

export function splitReplacement(content, ending) {
  if (!content) return []
  const text = /[\n\r]$/.test(content) ? content : content + ending
  return splitLines(text)
}

export const endingOf = line => line?.endsWith("\r\n") ? "\r\n" : line?.endsWith("\n") ? "\n" : line?.endsWith("\r") ? "\r" : ""
export const compilePattern = p => { try { const m = p.match(/^\/(.*)\/([a-z]*)$/); return success(m ? new RegExp(m[1], m[2]) : new RegExp(p)) } catch(e) { return failure(`Invalid regular expression: ${e.message}. Fix pattern and grep again.`) } }
export const stripAt = p => p.startsWith("@") ? p.slice(1) : p
export const formatEditResult = (path, p, serials, end = p.endExclusive) => `Edited ${path} at [${numToAlpha(p.begin)}, ${numToAlpha(end)}).${serials.length ? ` New serials: ${serials.map(numToAlpha).join(", ")}.` : ""}`
export const success = value => ({ ok: true, value })
export const failure = (error, meta = {}) => ({ ok: false, error, ...meta })
export const detailedSymbol = Symbol("detailed")
export function splitLines(text) {
  const res = []
  for (let i = 0, start = 0; i < text.length; i++) {
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) {
      res.push(text.slice(start, i + 1))
      start = i + 1
    } else if (text[i] === "\r" && text[i + 1] === "\n") {
      res.push(text.slice(start, i + 2))
      i++
      start = i + 1
    }
    if (i === text.length - 1 && start < text.length) res.push(text.slice(start))
  }
  return res
}
