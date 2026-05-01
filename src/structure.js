import languagePack from "@kreuzberg/tree-sitter-language-pack"

const structCache = new Map()
const STRUCT_CACHE_MAX = 500

export function detectStructure(path, content, mtimeMs) {
  const cacheKey = `${path}::${mtimeMs ?? 0}`
  const cached = structCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    const lang = languagePack.detectLanguageFromPath(path) ?? languagePack.detectLanguageFromContent(content)
    if (!lang) { structCache.set(cacheKey, null); return null }
    const res = languagePack.process(content, { language: lang })
    const lines = res?.structure?.map(i => i.span?.startLine).filter(Number.isInteger)
    const result = lines?.length ? [...new Set(lines)].sort((a, b) => a - b) : null
    structCache.set(cacheKey, result)
    if (structCache.size > STRUCT_CACHE_MAX) {
      const key = structCache.keys().next().value
      structCache.delete(key)
    }
    return result
  } catch (err) {
    process.stderr.write(`Warning: Failed to detect structure for ${path} (${err.message})\n`)
    return null
  }
}
