# editplus

`editplus` is a pi/GSD extension that replaces path-based editing with stable serial-number editing.

It provides three tools:

- `read` assigns global serial numbers to file lines.
- `grep` searches files and returns serial-numbered matches.
- `edit` replaces content by serial range, without requiring a path or old-text match.

The goal is to make edits precise after a file has been inspected once. The agent copies serial numbers from `read` or `grep`, then edits by serial endpoints.

## Install

```sh
npm install
```

The package declares itself as a pi extension and exports the extension entrypoint directly.

## Tools

### read

`read` loads a file and assigns fresh global serial numbers to every line.

Required parameter:

- `path`: file path to read

Optional parameters:

- `begin`: inclusive serial from an earlier `read` or `grep`
- `endExclusive`: exclusive serial where the range stops

Calling `read` without a range returns a serial-numbered view. For large structured files, it returns a structural summary and still assigns serials that can be used for follow-up range reads.

Example output:

```text
1|const answer = 42
2|console.log(answer)
```

To read only one exact range, pass serial endpoints from an earlier output.

### grep

`grep` searches a file or glob with a JavaScript regular expression and returns serial-numbered results.

Required parameters:

- `path`: file path or glob pattern
- `pattern`: JavaScript regular expression, either plain text or slash form such as `/foo/i`

The returned serials can be passed directly to `edit`.

### edit

`edit` replaces content in the half-open serial range `[begin, endExclusive)`.

Required parameters:

- `begin`: inclusive start serial
- `endExclusive`: exclusive end serial
- `content`: replacement text; use an empty string to delete

`edit` does not take a path. Both serials must resolve to the same file. If the file changed outside editplus after the serials were issued, the edit is rejected and the file must be read again.

## Serial range semantics

Serials are endpoints, not line numbers.

A replacement range removes every real line from `begin` up to, but not including, `endExclusive`, then inserts `content` at `begin`.

A pure insertion is represented by two different serials that resolve to the same real file line. This usually happens after reading or grepping the same file more than once. Because both serials point to the same insertion boundary, no existing line is removed.

After an edit:

- serials for replaced lines become stale
- serials for inserted lines are newly assigned
- serials for untouched later lines continue to resolve after line-number shifts

## Safety rules

The extension rejects edits when:

- a serial does not exist
- a serial is stale
- the range spans multiple files
- the range is reversed
- the file changed outside trueline after the serials were issued

Line endings are preserved. Replacement text without a trailing newline receives the edited line's existing newline style.

## Development

Run the test suite with:

```sh
npm test
```

The tests cover line splitting, registry behavior, range edits, insertion, deletion, CRLF preservation, stale serial rejection, external file-change detection, glob search, and invalid regular expression errors.
errors.
