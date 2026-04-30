import languagePack from "@kreuzberg/tree-sitter-language-pack"

export function detectStructure(path, content) {
  try {
    const language = languagePack.detectLanguageFromPath(path)
      ?? languagePack.detectLanguageFromContent(content)
    if (!language) return null

    const result = languagePack.process(content, { language })
    const lines = result?.structure
      ?.map(item => item.span?.startLine)
      .filter(line => Number.isInteger(line))

    return lines?.length ? [...new Set(lines)].sort((a, b) => a - b) : null
  } catch {
    return null
  }
}

export function blockForLine(structure, line, totalLines) {
  if (!structure?.length) return [0, totalLines]

  let start = 0
  for (const candidate of structure) {
    if (candidate > line) break
    start = candidate
  }

  const next = structure.find(candidate => candidate > line)
  return [start, next ?? totalLines]
}
