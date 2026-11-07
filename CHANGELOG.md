# Changelog

## Unreleased

### Fixed
- `\`-newline line continuations were read as a word, so `sudo \⏎ grep …` or `cd x && \⏎ grep …` got no note.
- `&&`/`||` inside `[[ … ]]` split the command, so `[[ -f a && -f b ]]` got no note.
- `/usr/bin/which` and `/usr/bin/test` (full paths) were not matched, unlike every other rule.
- `timeout -s SIG N cmd` / `timeout -k D N cmd` mistook the option value for the duration, so the wrapped command was not found.
- A result with no output before the marker got a stray leading blank line above the note.
- Running the hook twice on the same result (e.g. an earlier policy already annotated it) added a second note; it is now added at most once.

### Changed
- README now matches actual behaviour: lists `colordiff`, `command -V`, `jq --exit-status`/`-re` and `false`; spells out every stay-quiet case (including `;`/`&&` followed by another command, `|&`, `{ …; }`, process substitution, here-strings, `xargs`, unterminated quotes) and every looked-through prefix; documents custom-rule matching and `prompt: false`.

### Tests
- New `test/coverage.test.js` (23 tests) covering every built-in rule, every stay-quiet case, look-through prefixes, the "Assuming…" variant, custom rules and precedence, the `tools` filter, `prompt: false`, quoting, unicode, empty output, marker position and idempotence.

## 0.1.0

- Initial release.
