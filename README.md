# editplus

**Tag-based file read, edit, and search tools for AI agents — designed for pi/GSD.**

editplus fixes a fundamental problem in LLM-native code editing: instead of matching old text patterns or specifying file paths for every operation, it assigns **stable tags** to each line when a file is read. Every subsequent edit references those tags — no path, no old-text match, no ambiguity.

Three integrated tools — `read`, `edit`, `grep` — work together through a shared tag registry that tracks tag-to-line mapping, file mtime, and concurrent write safety.

## Why editplus

Traditional LLM coding tools rely on find-and-replace text matching, which is fragile: a single whitespace difference, a comment that changed, or a different branch of code causes the edit to fail. editplus replaces text matching with **tag addressing**:

- **Read** a file → each line gets a unique tag (`A`, `B`, ..., `Z`, `AA`, `AB`, ...)
- **Edit** by tag range — `begin: "B", endExclusive: "C", content: "..."` — no old text needed
- **Grep** returns tagged results you can edit immediately

The result: edits are deterministic, never confused by ambiguous matches, and work correctly even on files with complex formatting.

## Tools

### read

Load a file and assign fresh tags to every line.

- `path` — file path (optional; defaults to `.`)
- `begin` — tag for range read
- `endExclusive` / `endInclusive` — range boundary

Calling `read` with no range params prints a tag-numbered view. For structured code, it uses **tree-sitter** to detect structure and prints a structural summary — only showing function boundaries, class definitions, and key landmarks — making large files navigable without dumping the whole thing.

### grep

Search files with a JavaScript regex and return tag-numbered results ready for editing.

- `path` — Git pathspec, directory, or file path
- `pattern` — plain text or `/pattern/flags`
- `includeIgnored` — search inside `.gitignore`-ignored paths

Results are grouped by file and match block, with a summary view showing adjacent context lines. Every result line carries its tag — pass it straight to `edit`.

### edit

Replace content by tag range `[begin, endExclusive)`.

- `begin` — inclusive start tag
- `endExclusive` / `endInclusive` — exclusive or inclusive end tag
- `content` — replacement text; empty string to delete

Both `endExclusive` and `endInclusive` are supported for precise control over whether the end delimiter (closing brace, tag, etc.) is preserved or replaced.

## Key features

### 🧩 Concurrency-safe parallel edits

Multiple edits on the **same file** can be submitted concurrently — writes are serialized by a per-file lock, and tag-to-line resolution happens inside the lock, so concurrent edits never corrupt each other. Edits on different files run in true parallel.

### 🧠 Stale & external change detection

If a file changed outside editplus after tags were issued, the edit is rejected with a clear error message and the **current file summary is auto-attached** — the LLM can immediately re-read and retry. Tags from external changes are detected via mtime tracking.

### 📐 Structural intelligence

Read and grep use **tree-sitter** to understand code structure. Reads of structured files show structural summaries (function/class boundaries) instead of raw line dumps. Grep results are organized by match block, making it easy to understand context.

### 🔄 Stable tags across edits

Tags for untouched lines remain stable after editing unrelated parts of the file — no cascading renumbering. Only affected lines get new tags.

### 🔗 Cross-reference via tags

Tags are **global sequential identifiers**, not file-line numbers. A tag from one file never matches a line in another file. Tags from `read` and `grep` are interchangeable — read a file, grep for a pattern, edit the results.

## Tag semantics

| Operation | What happens |
|---|---|
| Replace | Lines `[begin, endExclusive)` removed, content inserted at begin |
| Insert | Both tags resolve to the same line. No line removed. |
| Delete | Empty content in range `[begin, endExclusive)` |

After edit: replaced-line tags become stale, new-line tags are assigned, untouched lines continue to resolve after line-number shifts.

## Install

```bash
npm install
```

editplus is a **pi/GSD extension**. It self-registers as a pi extension and provides the `read`, `edit`, and `grep` tools automatically.

## Test

```bash
npm test
```

24 integration tests cover tag-based read, edit (insert, delete, concurrent, stale detection, CRLF), grep (pattern matching, error handling), and edge cases (empty files, sentinel tags, external changes).
