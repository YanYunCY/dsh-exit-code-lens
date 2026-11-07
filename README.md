# dsh-exit-code-lens

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that stops the agent from "investigating" commands that worked.

中文：很多命令用非零退出码表示「答案」而不是「失败」：`grep` 没搜到返回 1，`diff` 有差异返回 1，`test` 为假返回 1。dsh 会把这类结果标成 `[exit code: 1]`、卡片变红，系统提示词又要求模型「每个 bash 结果都检查 exit code，出错先排查」，于是模型反复重跑、核查，白白浪费轮次和 token。这个插件在结果里补一行说明，告诉模型这不是错误，可以继续。

## The problem

dsh's bash tool appends `[exit code: N]` to every non-zero result, and its system prompt says *"Check the [exit code: N] marker on every bash result; investigate failures before moving on."* So when `grep -rn TODO src` finds nothing, the model treats "no matches" as a failure and goes digging: re-running the search, listing directories, checking the file exists.

Community reports:
- [Discussion #1884](https://github.com/deepseek-ai/deepseek-harness/discussions/1884): a third-party eval where an exit-1 loop roughly doubled requests (61 vs 32) on the same task.
- [Discussion #8403](https://github.com/deepseek-ai/deepseek-harness/discussions/8403): 7 of 56 tool results in one session were exit 1, all from how the command was written, not real errors.

## What it does

After every `bash` call it checks the command and exit code. When the status is a known *answer*, it adds one line above the marker:

```
(no output)
[exit-code note: grep exits 1 when no line matched. Nothing failed; the answer is "no matches".]
[exit code: 1]
```

The `[exit code: N]` marker stays the last line, so the terminal card still shows the exit pill. It also adds one sentence to the system prompt so the model knows to trust the note.

Built-in rules (exit 1 only):

| Command | Meaning of exit 1 |
|---|---|
| `grep` `egrep` `fgrep` `zgrep` `rg` `ag` `ack` `git grep` | no matches |
| `diff` `cmp` `colordiff` `git diff --exit-code/--quiet` | inputs differ |
| `test` `[` `[[` | condition is false |
| `which` `type` `command -v/-V` `hash` | not installed |
| `pgrep` `pidof` | no such process |
| `git merge-base --is-ancestor` | not an ancestor |
| `jq -e` (also `--exit-status`, combined flags like `-re`) | last output false/null |
| `false` | always exits 1 |

Commands are matched by name, so full paths (`/usr/bin/grep`, `./node_modules/.bin/rg`) and quoted names (`"grep"`) work. `git` global options before the subcommand (`-C dir`, `-c k=v`, `--no-pager`) are skipped. Plain `git diff` (without `--exit-code`/`--quiet`) never exits 1 for changes, so it gets no note.

## When it stays quiet

It is deliberately conservative. No note is added when:
- anything non-blank was written to stderr (`grep pattern missing-file` exits 2 and prints an error — that *is* a failure);
- the exit code is anything other than the rule's code (e.g. `grep` 2, `diff` 2, 124 from `timeout`, 127 not found);
- the deciding command is not the last one: `grep x f | wc -l`, `grep x f; npm test`, `grep x f && npm test`, `grep x f |& tee out`;
- the command contains `||` or a background `&` anywhere (`grep x f || echo none`, `cmd &`, `cmd & wait`);
- the command uses control flow or negation (`if`, `for`, `while`, `case`, `function`, `!`), subshells, `{ …; }` groups or process substitution (`( … )`, `diff <(sort a) <(sort b)`), heredocs or here-strings (`<<EOF`, `<<<`), or has an unterminated quote;
- the deciding command runs through `xargs` (it maps child exit codes to 123);
- the call was killed, timed out, failed to run, or the result has no `[exit code: N]` marker;
- the result already carries an `[exit-code note: …]` line (it is never added twice).

Looked through, so the real command decides: leading `VAR=x` assignments, `env [-i] [VAR=x]`, `sudo`/`doas` (flags without values, e.g. `-E`), `timeout [--signal=S | -s S | -k D] N`, `nice [-n N]`, `ionice [-c N]`, `nohup`, `time`, `command`, `exec`, `stdbuf`, redirects anywhere in the command (`2>/dev/null`, `>/dev/null 2>&1`, `&>out`, `< input`), trailing `# comments` and `\`-newline line continuations. `&&` and `||` inside `[[ … ]]` belong to the test, so `[[ -f a && -f b ]]` is treated as one `[[` command.

For a pipeline, or a command with an earlier `&&`/`;`/newline step (`cat log | grep x`, `cd src && grep …`), the note ends with "(Assuming the status came from the last command.)", because with `pipefail` or a failing earlier step the status could come from elsewhere.

## Install

```bash
dsh plugin --profile <profile> add github:YanYunCY/dsh-exit-code-lens
```

Requires Node ≥ 24.9. Tested with dsh 0.2.1-rc.5. No build step, no runtime dependencies, no network access.

## Configure (optional)

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: exit-code-lens
  config:
    tools: [bash]          # tool names to annotate
    prompt: true           # add the one-line system-prompt hint
    rules:                 # your own tools, checked before the built-ins (a match here wins)
      - command: mytool
        subcommand: check
        codes: [3]
        note: "{cmd} exits {code} when the check is still pending. Nothing failed."
```

`command` can be a name or a list of names (matched by basename, after the same look-through as built-ins); `subcommand`, when set, must be the first argument; `{cmd}` and `{code}` in `note` become the command name and the exit code. The stay-quiet rules above apply to custom rules too. `prompt: false` drops only the system-prompt sentence; results are still annotated.

## Cost

One extra line per matching result, and one sentence (~70 tokens) in the system prompt. The prompt sentence is static, so it does not break the KV cache between requests. Set `prompt: false` to drop it.

## Does it help? (measured)

We ran 4 tasks that lead the model into `grep`, `diff`, `git diff --exit-code` and `test -f` returning 1, 3 times each, with and without the plugin, on DeepSeek's official API (2026-11-05):

| Model | Steps (off / on) | Tool calls (off / on) |
|---|---|---|
| `deepseek-flash` | 30 / 30 | 18 / 19 |
| `deepseek-v4-pro` | 24 / 24 | 12 / 12 |

Today's official models already took exit 1 at face value on these simple tasks, so the plugin made **no measurable difference** there, and the prompt sentence costs a few percent more input tokens. It is aimed at older, smaller or relayed models that do loop on harmless exit codes (as in the reports above). If your model doesn't loop, you don't need it.

中文：在官方 `deepseek-flash` 与 `deepseek-v4-pro` 上实测无差异（模型本身已不会被 exit 1 带偏）。本插件主要面向较旧、较小或经中转的、仍会反复核查的模型。

## What it does not do

- It does not hide the exit code or turn the card green. The model still sees the real status.
- It does not cover PowerShell or Windows `cmd` yet.

## License

MIT
