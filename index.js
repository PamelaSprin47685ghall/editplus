import { createHandlers } from "./src/handlers.js"

const handlers = createHandlers()

const readParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path or directory to read. If a directory is provided, returns a recursive size listing (pseudo du -hxd1)." },
    begin: { type: "string", description: "Inclusive serial from a previous read or grep output." },
    endExclusive: { type: "string", description: "(Recommended) THINK TWICE: The line at endExclusive is EXCLUDED from the read output." },
    endInclusive: { type: "string", description: "THINK TWICE: The line at endInclusive is INCLUDED in the read output. Mutually exclusive with endExclusive." },
  },
  required: ["path"],
}
const editParams = {
  type: "object",
  properties: {
    begin: { type: "string", description: "Inclusive start serial from read or grep. Always required." },
    endExclusive: { type: "string", description: "(Recommended) THINK TWICE: The line at endExclusive is PRESERVED. Use this if you want to replace up to, but NOT including, this line. (Useful for pure insertions when begin == endExclusive)" },
    endInclusive: { type: "string", description: "THINK TWICE: The line at endInclusive is REPLACED. Use this if your replacement should include this line. Mutually exclusive with endExclusive." },
    content: { type: "string", description: "Replacement text. Always required. Empty string deletes the range. Must NOT include the closing brace/tag if you used endExclusive on it!" },
  },
  required: ["begin", "content"],
}

const grepParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "Git pathspec, directory, or file path to search." },
    includeIgnored: { type: "boolean", description: "If true, searches inside .gitignore ignored files/directories. Default is false." },
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
    description: "Read a file to get serial numbers, or read a directory to get a recursive size listing (pseudo du -hxd1).",
    promptGuidelines: [
      "Use read instead of cat, head, tail, or sed.",
      "Pass a directory path to get a recursive file size listing.",
      "Copy serial numbers exactly; edit uses them instead of paths.",
      "Never guess serial numbers — yours must appear in some previous read/grep output. Never use a serial larger than the largest you have seen.",
      "Serials are file-specific — a serial from one file cannot be used for another file.",
      "Serials shown in ANY previous read/grep output can still be used — old serials remain valid.",
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
      "Serials are file-specific — using a serial from one file on another file will fail.",
      "You may use serials shown in ANY previous read/grep output — old serials still work even after edits.",
      "Never guess serial numbers; only use ones actually shown in read/grep output. Serials are NOT file line numbers — never use a serial larger than the largest you have seen in any output.",
      "endExclusive is EXCLUSIVE — serials from begin up to endExclusive-1 are replaced. To replace a block including its closing line, set endExclusive ONE PAST that line.",
      "endExclusive resolving to the same file line as begin = insert before that line (pure insertion).",
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
      "Path uses Git pathspec syntax (e.g., src, src/**/*.js) and respects .gitignore natively.",
      "Use includeIgnored: true to bypass .gitignore.",
      "Requires a Git repository.",
      "Serials from grep output belong to the matched file only — do not use them on other files.",
      "Serials from ANY previous grep remain valid; you do not need to re-read before editing.",
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
  if (typeof result.value === "object" && result.value !== null && result.value.isDetailed) { return { content: [{ type: "text", text: truncate(result.value.text) }], details: result.value.details } }
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
