# editplus

pi/GSD extension providing serial-number-based file editing.

Instead of specifying paths and text patterns, editplus assigns global serial numbers to file lines on read. Subsequent edits reference those serials — no path, no old-text match required.

## Tools

### read

Load a file and assign fresh serial numbers to every line.

- `path` — file path (optional; defaults to `.` when omitted, resolves from serial when serial params present)
- `begin` — serial from a prior read or grep
- `endExclusive` — serial at which the range stops (exclusive)

Without range params, prints a serial-numbered view. For structured files, prints a structural summary with serials still usable for follow-up range reads.

### grep

Search files with a JavaScript regex and return serial-numbered results.

- `path` — file path or glob pattern
- `pattern` — plain text or `/pattern/flags`
- `includeIgnored` — search inside `.gitignore`-ignored paths

Returned serials can be passed directly to edit.

### edit

Replace content in the half-open serial range `[begin, endExclusive)`.

- `begin` — inclusive start serial
- `endExclusive` — exclusive end serial
- `content` — replacement text; empty string to delete

Both serials must resolve to the same file. If the file changed outside editplus after serials were issued, the edit is rejected — re-read first.

Parallel edits on the same file are safe and encouraged — writes are serialized internally with correct line-position re-resolution, so concurrent edits never corrupt each other.

## Serial semantics

| Operation | What happens |
|---|---|
| Replace | Lines `[begin, endExclusive)` removed, content inserted at begin |
| Insert | Both serials resolve to the same file line (from different reads). No line removed. |
| Delete | Empty content in range `[begin, endExclusive)` |

After edit: replaced-line serials become stale, new-line serials are assigned, untouched lines continue to resolve after line-number shifts.

## Install

```
npm install
```

Requires pi/GSD. The package declares itself as a pi extension.

## Test

```
npm test
```
