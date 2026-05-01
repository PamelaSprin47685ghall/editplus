export function numToTag(n) {
  let res = ""
  for (; n > 0; n = Math.floor((n - 1) / 52)) {
    const off = (n - 1) % 52
    res = String.fromCharCode(off < 26 ? 65 + off : 71 + off) + res
  }
  return res
}

export function tagToNum(s) {
  let res = 0
  for (const c of s) {
    const code = c.charCodeAt(0)
    if (code >= 65 && code <= 90) res = res * 52 + code - 64
    else if (code >= 97 && code <= 122) res = res * 52 + code - 70
    else return NaN
  }
  return res
}

export function readRange(registry, params, file) {
  if (params.begin != null) {
    const begin = resolveTag(registry, params.begin, "reading", "begin tag")
    let end = null
    if (params.endInclusive != null) {
      const e = resolveTag(registry, params.endInclusive, "reading", "endInclusive tag")
      end = e.ok ? { ok: true, value: { path: e.value.path, line: e.value.line + 1 } } : e
    } else if (params.endExclusive != null) {
      end = resolveTag(registry, params.endExclusive, "reading", "endExclusive tag")
    }
    if (!begin.ok) return begin
    if (end && !end.ok) return end
    if (begin.value.path !== file.path || (end && end.value.path !== file.path)) return failure("Requested tag range does not belong to this path.")
    if (end && end.value.line < begin.value.line) return failure("Tag range is reversed.")
    return success({ from: begin.value.line, to: end ? end.value.line : begin.value.line + 1, heading: "", hint: "" })
  }

  const struct = file.structure
  const shown = new Set([0, 1, 2, file.lines.length - 2, file.lines.length - 1])
  if (struct) struct.forEach(l => shown.add(l))
  return success({
    from: 0, to: file.lines.length,
    indexes: (!struct?.length || file.lines.length <= 80) ? null : [...shown].filter(l => l >= 0 && l < file.lines.length).sort((a, b) => a - b),
    heading: `Summary for ${file.path}`,
    hint: struct?.length ? "This is a structural summary. Use begin/endExclusive tags to read an exact range." : "Use begin/endExclusive tags to read an exact range.",
  })
}

export function resolveTag(registry, tag, action = "use", role = "tag") {
  if (typeof tag === "string" && /^[0-9]+$/.test(tag.trim())) return failure("Raw numeric tags are not allowed.")
  const num = typeof tag === "string" ? tagToNum(tag) : tag
  const disp = typeof tag === "string" ? tag : numToTag(tag)
  const entry = registry.resolve(num)
  if (!entry) return failure(`${role} ${disp} does not exist. Re-read the file and copy a current tag.`)
  if (entry.expired) return failure(`${role} ${disp} has expired (allocations exceeded). Re-read the file and copy a current tag.`)
  if (entry.external) return { ok: false, error: `File changed outside editplus since ${role} ${disp} was generated. Re-read the file before ${action}.`, path: entry.path }
  if (entry.stale) return { ok: false, error: `${role} ${disp} is stale (line was edited or deleted). Re-read the file before ${action}.`, path: entry.path }
  return success(entry)
}

export function formatTag(getTag, lines, indexes) {
  const labels = indexes.map(getTag)
  const width = Math.max(...labels.map(s => s.length), 1)
  return indexes.map((idx, i) => {
    const line = lines[idx]
    const suffix = line?.endsWith('\n') || line?.endsWith('\r') ? line : (line || '') + '\n'
    return `${labels[i].padStart(width)}|${suffix}`
  }).join("")
}

export const stripAt = p => p.startsWith("@") ? p.slice(1) : p

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
