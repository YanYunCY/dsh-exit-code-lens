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
| `diff` `cmp` `git diff --exit-code/--quiet` | inputs differ |
| `test` `[` `[[` | condition is false |
| `which` `type` `command -v` `hash` | not installed |
| `pgrep` `pidof` | no such process |
| `git merge-base --is-ancestor` | not an ancestor |
| `jq -e` | last output false/null |

## When it stays quiet

It is deliberately conservative. No note is added when:
- anything was written to stderr (`grep pattern missing-file` exits 2 and prints an error — that *is* a failure);
- the exit code is anything other than the rule's code (e.g. `grep` 2, `diff` 2);
- the deciding command is not the last one: `grep x f | wc -l`, `grep x f || echo none`, `cmd &`;
- the command uses control flow, subshells or heredocs (`if`, `for`, `( … )`, `<<EOF`);
- the call was killed, timed out, or failed to run.

Leading `VAR=x`, `env`, `sudo`, `timeout N`, `nice -n N` and redirects like `2>/dev/null` are looked through. For pipelines or `cd x && grep …` the note adds "(Assuming the status came from the last command.)"

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
    rules:                 # your own tools, checked before the built-ins
      - command: mytool
        subcommand: check
        codes: [3]
        note: "{cmd} exits {code} when the check is still pending. Nothing failed."
```

## Cost

One extra line per matching result, and one sentence (~70 tokens) in the system prompt. The prompt sentence is static, so it does not break the KV cache between requests. Set `prompt: false` to drop it.

## What it does not do

- It does not hide the exit code or turn the card green. The model still sees the real status.
- It does not cover PowerShell or Windows `cmd` yet.

## License

MIT
