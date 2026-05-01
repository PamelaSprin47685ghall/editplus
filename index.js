import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createHandlers } from "./src/handlers.js"
import { detailedSymbol } from "./src/text.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadPrompts() {
  const md = readFileSync(resolve(__dirname, "prompts.md"), "utf8")
  const sections = md.split(/\n(?=# )/)
  const prompts = {}
  for (const section of sections) {
    const m = section.match(/^# (\w+)\n([\s\S]*)$/)
    if (m) prompts[m[1]] = m[2].trim()
  }
  return prompts
}

const prompts = loadPrompts()

const handlers = createHandlers()

const readParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path or directory to read." },
    begin: { type: "string", description: "Inclusive start tag." },
    endExclusive: { type: "string", description: "Exclusive end tag. The line at this tag is omitted." },
    endInclusive: { type: "string", description: "Inclusive end tag. Mutually exclusive with endExclusive." },
  },
  required: [],
}

const editParams = {
  type: "object",
  properties: {
    begin: { type: "string", description: "Inclusive start tag." },
    endExclusive: { type: "string", description: "Exclusive end tag. The line at this tag is PRESERVED (not replaced). Only lines from begin up to endExclusive-1 are replaced. Use this to keep the end delimiter (closing brace/tag). Pure insertion when begin == endExclusive." },
    endInclusive: { type: "string", description: "Inclusive end tag. This line IS REPLACED. Use this when you want the replacement to include the end line (closing brace/tag). WARNING: your content MUST include that closing line too, or it gets deleted!" },
    content: { type: "string", description: "Replacement text." },
  },
  required: ["begin", "content"],
}

const grepParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "Git pathspec, directory, or file path to search." },
    includeIgnored: { type: "boolean", description: "If true, searches inside .gitignore ignored files/directories." },
    pattern: { type: "string", description: "JavaScript regular expression pattern." },
  },
  required: ["path", "pattern"],
}

export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "edit" && event.input.path === undefined) {
      event.input.path = ""
    }
  })

  pi.registerTool({
    name: "read",
    label: "read",
    description: prompts.read,
    parameters: readParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.read({ ...params, projectDir: ctx.cwd }))
    },
  })

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: prompts.edit,
    parameters: editParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.edit({ ...params, projectDir: ctx.cwd }))
    },
  })

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: prompts.grep,
    parameters: grepParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.grep({ ...params, projectDir: ctx.cwd }))
    },
  })
}

function toToolResult(result) {
  if (!result.ok) return textResult(result.error, true)
  if (typeof result.value === "object" && result.value !== null && result.value[detailedSymbol]) { return { content: [{ type: "text", text: truncate(result.value.text) }], details: result.value.details } }
  return textResult(truncate(String(result.value)))
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError }
}

function truncate(text) {
  const lines = text.split("\n")
  let limited = lines.slice(0, 2000).join("\n")
  if (Buffer.byteLength(limited) > 50_000) {
    const buf = Buffer.from(limited)
    let end = 50_000
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end--
    limited = buf.toString("utf8", 0, end)
  }
  return limited === text ? text : `${limited}\n\n[Output truncated. Re-run with a narrower range.]`
}
