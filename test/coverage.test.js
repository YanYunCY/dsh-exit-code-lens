// Exhaustive coverage of the README contract: every built-in rule, every
// "stays quiet" case, look-through prefixes, config, quoting and annotation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explain, lex, unwrap, decide, annotate, apply, PROMPT_TEXT, BUILTIN_RULES } from '../src/index.js'

const rule = (cmd, code = 1, stderr = '') => explain(cmd, code, { stderr })?.rule
const note = (cmd, code = 1) => explain(cmd, code)?.note

test('every built-in rule in the README table fires on exit 1', () => {
  const table = {
    grep: ['grep x f', 'egrep x f', 'fgrep x f', 'zgrep x f.gz'],
    rg: ['rg x'],
    ag: ['ag x', 'ack x'],
    'git-grep': ['git grep x', 'git --no-pager grep x', 'git -c core.quotepath=off grep x'],
    diff: ['diff a b', 'cmp a b', 'colordiff a b'],
    'git-diff': ['git diff --exit-code', 'git diff --quiet', 'git -C repo diff --quiet HEAD'],
    test: ['test -f x', '[ -d x ]', '[[ -n "" ]]'],
    which: ['which foo', 'type foo', 'command -v foo', 'command -V foo', 'hash foo'],
    pgrep: ['pgrep -f srv', 'pidof srv'],
    'git-ancestor': ['git merge-base --is-ancestor a b'],
    'jq-e': ['jq -e .x f', 'jq --exit-status .x f', 'jq -re .x f'],
    false: ['false'],
  }
  for (const [id, cmds] of Object.entries(table)) for (const c of cmds) assert.equal(rule(c), id, c)
  assert.deepEqual(BUILTIN_RULES.map(r => r.id).sort(), Object.keys(table).sort(), 'table covers every built-in')
})

test('notes name the command actually used', () => {
  assert.match(note('egrep x f'), /^egrep exits 1/)
  assert.match(note('/usr/bin/grep x f'), /^grep exits 1/)
  assert.match(note('[ -f x ]'), /^\[ exits 1/)
  assert.match(note('[[ -f x ]]'), /^\[\[ exits 1/)
  assert.match(note('cmp a b'), /^cmp exits 1 when the inputs differ/)
  assert.match(note('pidof x'), /^pidof exits 1/)
})

test('rules that need a flag stay quiet without it', () => {
  for (const c of ['git diff', 'git diff HEAD', 'git merge-base a b', 'jq .x f', 'jq -r .x f', 'command foo', 'git log']) {
    assert.equal(rule(c), undefined, c)
  }
})

test('stays quiet: stderr present', () => {
  assert.equal(rule('grep x f', 1, 'grep: f: No such file or directory'), undefined)
  assert.equal(rule('diff a b', 1, 'warning'), undefined)
  assert.equal(rule('grep x f', 1, '  \n'), 'grep', 'whitespace-only stderr is not a message')
})

test('stays quiet: other exit codes', () => {
  for (const code of [0, 2, 3, 124, 126, 127, 130, 137, 255, -1]) assert.equal(rule('grep x f', code), undefined, String(code))
  assert.equal(rule('diff a b', 2), undefined)
  assert.equal(rule('test -f x', 2), undefined)
  assert.equal(explain('grep x f', 1.5), undefined)
  assert.equal(explain('grep x f', '1'), undefined)
  assert.equal(explain(undefined, 1), undefined)
})

test('stays quiet: deciding command is not last, ||, &', () => {
  for (const c of [
    'grep x f | wc -l', 'grep x f | head', 'grep x f || echo none', 'grep x f || true', 'test -f a || grep x a',
    'grep x f &', 'grep x f & wait', 'grep x f; npm test', 'grep x f && npm test', 'grep x f |& tee out',
  ]) assert.equal(rule(c), undefined, c)
})

test('stays quiet: control flow, subshells, groups, heredocs, process substitution', () => {
  for (const c of [
    'if grep -q x f; then echo y; fi', 'for f in *; do grep x $f; done', 'while read l; do grep x; done < f',
    'case $x in a) grep x;; esac', '! grep x f', '(grep x f)', '(cd a && grep x f)', '{ grep x f; }',
    'grep x <<EOF\nx\nEOF', "grep x <<'EOF'\nx\nEOF", 'grep x <<< "$v"', 'diff <(sort a) <(sort b)',
    'function f { grep x; }', "grep 'unterminated", 'grep "unterminated', 'grep `unterminated',
  ]) assert.equal(rule(c), undefined, JSON.stringify(c))
})

test('stays quiet: xargs and unknown commands', () => {
  for (const c of ['xargs grep x < files', 'find . | xargs grep x', 'npm test', 'make', 'ls nope', 'cat f', '']) {
    assert.equal(rule(c), undefined, c)
  }
})

test('look-through prefixes resolve to the deciding command', () => {
  for (const c of [
    'LC_ALL=C grep x f', 'A=1 B=2 grep x f', 'env grep x f', 'env FOO=1 grep x f', 'env -i grep x f',
    'sudo grep x f', 'sudo -E grep x f', 'doas grep x f', 'timeout 5 grep x f', 'timeout --signal=KILL 5 grep x f',
    'timeout -s KILL 5 grep x f', 'timeout -k 2 10 grep x f', 'nice grep x f', 'nice -n 10 grep x f', 'nohup grep x f',
    'time grep x f', 'command grep x f', 'exec grep x f', 'stdbuf -oL grep x f', 'ionice -c 2 grep x f',
    'grep x f 2>/dev/null', 'grep x f >/dev/null 2>&1', 'grep x f > out', 'grep x f &>/dev/null', 'grep x < input',
    '2>/dev/null grep x f', 'LC_ALL=C sudo env X=1 timeout 5 nice -n 5 grep x f 2>/dev/null',
  ]) assert.equal(rule(c), 'grep', c)
  assert.deepEqual(unwrap(['nice', '-n', '5', 'grep', 'x']), ['grep', 'x'])
  assert.deepEqual(unwrap(['command', '-v', 'foo']), ['command', '-v', 'foo'])
})

test('line continuations are not words', () => {
  assert.equal(rule('sudo \\\n  grep x f'), 'grep')
  assert.equal(rule('cd src && \\\n  grep -rn x .'), 'grep')
  assert.equal(rule('git \\\n  diff --exit-code'), 'git-diff')
  assert.deepEqual(lex('grep -rn x \\\n  src').pipelines[0].cmds[0], ['grep', '-rn', 'x', 'src'])
})

test('[[ … ]] keeps && and || inside the expression', () => {
  assert.equal(rule('[[ -f a && -f b ]]'), 'test')
  assert.equal(rule('[[ -n "$a" || -z "$b" ]]'), 'test')
  assert.doesNotMatch(note('[[ -f a && -f b ]]'), /last command/)
  assert.equal(rule('[[ -f a ]] && grep x a'), 'grep', '&& after ]] still splits')
  assert.equal(rule('[[ -f a ]] || grep x a'), undefined, '|| after ]] still splits')
})

test('"Assuming the status came from the last command." variant', () => {
  const tail = ' (Assuming the status came from the last command.)'
  assert.ok(note('cat f | grep x').endsWith(tail))
  assert.ok(note('cd a && grep x f').endsWith(tail))
  assert.ok(note('cd a; grep x f').endsWith(tail))
  assert.ok(note('cd a\ngrep x f').endsWith(tail))
  assert.ok(!note('grep x f').endsWith(tail))
  assert.ok(!note('grep x f\n').endsWith(tail), 'trailing newline is not a second step')
  assert.ok(!note('grep x f # why').endsWith(tail), 'comment is not a step')
})

test('custom rules: placeholders, subcommand, multiple names, precedence', () => {
  const rules = [
    { command: 'mytool', subcommand: 'check', codes: [3], note: '{cmd} exited {code}; {cmd} pending' },
    { command: ['a1', 'a2'], codes: [4, 5], note: '{cmd}:{code}' },
    { command: 'grep', codes: [1], note: 'custom grep note' },
  ]
  assert.equal(explain('mytool check', 3, { rules })?.note, 'mytool exited 3; mytool pending')
  assert.equal(explain('mytool check', 3, { rules })?.rule, 'user:mytool check')
  assert.equal(explain('/opt/bin/mytool check x', 3, { rules })?.note, 'mytool exited 3; mytool pending')
  assert.equal(explain('mytool run', 3, { rules }), undefined)
  assert.equal(explain('mytool check', 1, { rules }), undefined)
  assert.equal(explain('a2', 5, { rules })?.note, 'a2:5')
  assert.equal(explain('sudo a1 --x', 4, { rules })?.note, 'a1:4')
  assert.equal(explain('grep x f', 1, { rules })?.note, 'custom grep note', 'user rule beats built-in')
  assert.equal(explain('grep x f', 1, { rules })?.rule, 'user:grep')
  assert.equal(explain('rg x', 1, { rules })?.rule, 'rg', 'built-ins still apply')
  assert.equal(explain('mytool check | cat', 3, { rules }), undefined)
  assert.equal(explain('mytool check', 3, { rules, stderr: 'err' }), undefined)
})

test('quoting edge cases', () => {
  for (const c of [
    `grep 'a|b' f`, `grep "a;b" f`, `grep 'a && b' f`, `grep "x || y" f`, `grep 'a & b' f`, `grep "(x)" f`,
    `grep '<<EOF' f`, `grep "#notacomment" f`, `grep \\| f`, `grep \\; f`, `grep a\\ b f`, `grep \\( f`,
    `grep "$(echo x)" f`, 'grep `echo x` f', `grep "a\\"b" f`, `"grep" x f`, `'grep' x f`, `/usr/bin/grep x f`,
    `./node_modules/.bin/rg x`, `echo "a|b" | grep q`,
  ]) assert.equal(rule(c), c.includes('rg') ? 'rg' : 'grep', c)
  assert.deepEqual(lex(`grep -E 'a|b;c' f && echo "x && y"`).pipelines[0].cmds[0], ['grep', '-E', 'a|b;c', 'f'])
  for (const c of ['/usr/bin/which foo', '/usr/bin/test -f x', '/bin/[ -f x ]', '/usr/bin/diff a b', '/usr/bin/pgrep x']) {
    assert.ok(rule(c), c)
  }
})

test('unicode commands and paths', () => {
  assert.equal(rule('grep 中文 文件.txt'), 'grep')
  assert.equal(rule('rg "日本語|émoji 🎉" ./données'), 'rg')
  assert.equal(rule('ПЕРЕМЕННАЯ=1 grep x f'), undefined, 'non-ASCII is not a valid shell assignment')
})

// --- annotation / decide ---------------------------------------------------

const bashResult = (exitCode, stdout = '', stderr = '') => {
  let body = stdout
  if (stderr) body += `[stderr]\n${stderr}`
  if (!body) body = '(no output)'
  const text = exitCode === 0 ? body : `${body}${body.endsWith('\n') ? '' : '\n'}[exit code: ${exitCode}]`
  return {
    isError: false,
    content: [{ type: 'text', text }],
    value: { kind: 'foreground', cwd: '/w', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } },
  }
}
const exec = (command, name = 'bash') => ({ name, arguments: { command, description: 'x' } })
const cfg = { tools: ['bash'], rules: [] }
const accept = { kind: 'accept' }
const lastLine = t => t.split('\n').at(-1)

test('marker stays the last line, including with unicode and trailing whitespace', () => {
  for (const out of ['', 'résumé 🎉\n', 'line1\nline2', 'x\n\n']) {
    const r = bashResult(1, out)
    const t = decide(cfg, exec('grep x f'), r, accept).content[0].text
    assert.equal(lastLine(t), '[exit code: 1]', JSON.stringify(out))
    assert.match(t, /\n\[exit-code note: grep exits 1[^\n]*\]\n\[exit code: 1\]$/)
  }
  const t = annotate([{ type: 'text', text: 'out\n[exit code: 1]  \n' }], 'n')[0].text
  assert.equal(t, 'out\n[exit-code note: n]\n[exit code: 1]')
})

test('empty output: no stray leading newline', () => {
  assert.equal(annotate([{ type: 'text', text: '[exit code: 1]' }], 'n')[0].text, '[exit-code note: n]\n[exit code: 1]')
})

test('idempotent: a result that already has a note is not annotated again', () => {
  const r = bashResult(1)
  const once = decide(cfg, exec('grep x f'), r, accept)
  const twice = decide(cfg, exec('grep x f'), r, once)
  assert.equal(twice, once)
  assert.equal(once.content[0].text.match(/\[exit-code note:/g).length, 1)
  assert.equal(annotate(once.content, 'again'), undefined)
})

test('annotate only touches the last text block and keeps other blocks', () => {
  const content = [{ type: 'text', text: 'a\n[exit code: 1]' }, { type: 'image', data: 'x' }]
  const next = annotate(content, 'n')
  assert.equal(next[0].text, 'a\n[exit-code note: n]\n[exit code: 1]')
  assert.equal(next[1], content[1])
  assert.equal(annotate([{ type: 'image' }], 'n'), undefined)
  assert.equal(annotate('nope', 'n'), undefined)
})

test('tools filter', () => {
  const r = bashResult(1)
  assert.equal(decide(cfg, exec('grep x f', 'shell'), r, accept), accept)
  const both = { tools: ['bash', 'shell'], rules: [] }
  assert.ok(decide(both, exec('grep x f', 'shell'), r, accept).content)
  assert.equal(decide({ tools: [], rules: [] }, exec('grep x f'), r, accept), accept)
  assert.ok(decide({}, exec('grep x f'), r, accept).content, 'defaults to bash')
  assert.equal(decide(cfg, { name: 'bash', arguments: {} }, r, accept), accept, 'no command')
})

test('custom rules flow through decide', () => {
  const r = bashResult(3)
  const d = decide({ tools: ['bash'], rules: [{ command: 'mytool', codes: [3], note: '{cmd} {code} ok' }] }, exec('mytool'), r, accept)
  assert.match(d.content[0].text, /\[exit-code note: mytool 3 ok\]\n\[exit code: 3\]$/)
})

test('killed, timed out, failed to run, stderr: untouched', () => {
  const killed = bashResult(1); killed.value.signal = 'SIGKILL'
  const timed = bashResult(1); timed.value.timedOut = true
  const failed = { isError: true, content: [{ type: 'text', text: 'spawn failed\n[exit code: 1]' }] }
  const noCode = bashResult(1); noCode.value.exitCode = null
  const err = bashResult(1, '', 'grep: f: No such file')
  for (const r of [killed, timed, failed, noCode, err]) assert.equal(decide(cfg, exec('grep x f'), r, accept), accept)
  const noMarker = { isError: false, content: [{ type: 'text', text: 'hi' }] }
  assert.equal(decide(cfg, exec('grep x f'), noMarker, accept), accept)
})

test('apply registers the hook, swallows errors, and honours prompt:false', async () => {
  const mk = () => {
    const ctx = { handlers: {}, sections: [] }
    ctx.on = (ev, fn) => { ctx.handlers[ev] = fn }
    ctx.systemPrompt = { section: s => ctx.sections.push(s), getSectionOrder: () => 10 }
    return ctx
  }
  const on = mk(); apply(on, { tools: ['bash'], prompt: true, rules: [] })
  assert.equal(on.sections.length, 1)
  assert.equal(on.sections[0].text, PROMPT_TEXT)
  assert.equal(on.sections[0].order, 10.5)
  const d = await on.handlers['tools/post-execute'](exec('grep x f'), bashResult(1), async () => ({ kind: 'accept' }))
  assert.match(d.content[0].text, /\[exit-code note:/)
  // a malformed result must never break the tool call
  const bad = { kind: 'accept' }
  assert.equal(await on.handlers['tools/post-execute'](exec('grep x f'), null, async () => bad), bad)

  const off = mk(); apply(off, { tools: ['bash'], prompt: false, rules: [] })
  assert.equal(off.sections.length, 0)
  assert.ok(off.handlers['tools/post-execute'], 'annotation still on with prompt:false')
})
