import { createHandlers } from "./src/handlers.js"

const handlers = createHandlers()

const readParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path to read." },
    begin: { type: "number", description: "Inclusive serial from a previous read or grep output." },
    endExclusive: { type: "number", description: "Exclusive serial where the requested range stops." },
  },
  required: ["path"],
}

const editParams = {
  type: "object",
  properties: {
    begin: { type: "number", description: "Inclusive start serial from read or grep. Always required along with endExclusive and content." },
    endExclusive: { type: "number", description: "Exclusive end serial. Always required. May resolve to the same file line as begin for pure insertion." },
    content: { type: "string", description: "Replacement text. Always required. Empty string deletes the range." },
  },
  required: ["begin", "endExclusive", "content"],
}

const grepParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path or glob pattern to search." },
    pattern: { type: "string", description: "JavaScript regular expression pattern." },
  },
  required: ["path", "pattern"],
}

export default function (pi) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read a file and assign global serial numbers to every line. Use begin/endExclusive serials for exact ranges.",
    promptGuidelines: [
      "Use read instead of cat, head, tail, or sed.",
      "Copy serial numbers exactly; edit uses them instead of paths.",
      "Call read without begin/endExclusive first, then read exact serial ranges when needed.",
      "Serials are file-specific — a serial from one file cannot be used for another file.",
    ],
    ],
    parameters: readParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.read({ ...params, projectDir: ctx.cwd }))
    },
  })

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit file by serial range. All 3 params (begin, endExclusive, content) are ALWAYS required. No path or old text needed.",
    promptGuidelines: [
      "All 3 params are ALWAYS required: begin, endExclusive, content. Never omit any of them.",
      "Read or grep the target file first to get its current serials.",
      "Serials are file-specific — using a serial from one file on another file will fail.",
      "Never guess or compute serial numbers from memory. Only use numbers shown in the most recent read/grep output.",
      "If unsure, re-read the file to get fresh serials.",
      "endExclusive resolves to a file line; same line as begin = insert before that line.",
      "Empty content deletes the range.",
    ],
    parameters: editParams,
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.edit(params))
    },
  })

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: "Search files with a JavaScript regular expression and return serial-numbered matches that can be edited directly.",
    promptGuidelines: [
      "Use grep when you know a token or regex and need editable serials.",
      "grep serials map to real files and can be passed directly to edit.",
      "Path may be a single file or glob.",
      "Serials from grep output belong to the matched file only — do not use them on other files.",
    ],
    ],
    parameters: grepParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return textResult("Cancelled")
      return toToolResult(await handlers.grep({ ...params, projectDir: ctx.cwd }))
    },
  })
}

function toToolResult(result) {
  if (!result.ok) return textResult(result.error, true)
  return textResult(truncate(String(result.value)))
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError }
}

function truncate(text) {
  const lines = text.split("\n")
  let limited = lines.slice(0, 2000).join("\n")
  if (Buffer.byteLength(limited) > 50_000) limited = Buffer.from(limited).subarray(0, 50_000).toString()
  return limited === text ? text : `${limited}\n\n[Output truncated. Re-run with a narrower range.]`
}
