import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explain, lex, unwrap, decide, annotate, readOutcome, Config } from '../src/index.js'

const benign = (cmd, code = 1, stderr = '') => explain(cmd, code, { stderr })

test('plain no-match / differ / false commands are explained', () => {
  for (const cmd of [
    'grep -rn TODO src', 'rg foo', 'egrep -q x file', '/usr/bin/grep x y', 'git grep needle',
    'diff a.txt b.txt', 'cmp a b', 'git diff --exit-code', 'git -C repo diff --quiet HEAD',
    'test -f missing', '[ -d /nope ]', '[[ -n "" ]]', 'which foo', 'command -v foo', 'pgrep -f server',
    'git merge-base --is-ancestor a b', 'jq -e .x f.json',
  ]) assert.ok(benign(cmd), cmd)
})

test('wrappers, env assignments, redirects and pipelines resolve to the deciding command', () => {
  assert.equal(benign('sudo grep x /etc/hosts')?.rule, 'grep')
  assert.equal(benign('LC_ALL=C env FOO=1 timeout 5 rg x')?.rule, 'rg')
  assert.equal(benign('grep x file 2>/dev/null')?.rule, 'grep')
  assert.equal(benign('cat log | grep ERROR')?.rule, 'grep')
  assert.equal(benign('cd src && grep -rn "a && b" .')?.rule, 'grep')
  assert.match(benign('cat log | grep ERROR').note, /last command/)
  assert.doesNotMatch(benign('grep x f').note, /last command/)
})

test('real failures are left alone', () => {
  assert.equal(benign('grep x f', 2), undefined, 'grep 2 is an error')
  assert.equal(benign('grep x missing', 1, 'grep: missing: No such file'), undefined, 'stderr present')
  assert.equal(benign('npm test'), undefined)
  assert.equal(benign('make'), undefined)
  assert.equal(benign('grep x f | wc -l'), undefined, 'last command is wc')
  assert.equal(benign('grep x f || echo none'), undefined, '|| changes ownership')
  assert.equal(benign('grep x f; npm test'), undefined)
  assert.equal(benign('if grep -q x f; then echo y; fi'), undefined, 'control flow is skipped')
  assert.equal(benign('(grep x f)'), undefined, 'subshell is skipped')
  assert.equal(benign('xargs grep x < files'), undefined, 'xargs maps codes to 123')
  assert.equal(benign('grep x f', 0), undefined)
  assert.equal(benign('diff a b', 2), undefined, 'diff 2 is trouble')
  assert.equal(benign('git diff'), undefined, 'plain git diff never exits 1 for changes')
})

test('lexer keeps quoted operators inside words', () => {
  const { pipelines } = lex(`grep -E 'a|b;c' f && echo "x && y"`)
  assert.equal(pipelines.length, 2)
  assert.deepEqual(pipelines[0].cmds[0], ['grep', '-E', 'a|b;c', 'f'])
  assert.deepEqual(unwrap(['nice', '-n', '5', 'grep', 'x']), ['grep', 'x'])
})

test('user rules run before built-ins', () => {
  const rules = [{ command: 'mytool', subcommand: 'check', codes: [3], note: '{cmd} {code} = pending' }]
  assert.equal(explain('mytool check', 3, { rules })?.note, 'mytool 3 = pending')
  assert.equal(explain('mytool run', 3, { rules }), undefined)
  const cfg = new Config({ rules })
  assert.deepEqual(cfg.tools, ['bash'])
  assert.equal(cfg.prompt, true)
})

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
const exec = command => ({ name: 'bash', arguments: { command, description: 'x' } })
const cfg = { tools: ['bash'], rules: [] }

test('decide inserts the note above the exit marker and keeps the marker last', () => {
  const r = bashResult(1)
  const d = decide(cfg, exec('grep -rn foo .'), r, { kind: 'accept' })
  const text = d.content[0].text
  assert.match(text, /^\(no output\)\n\[exit-code note: grep exits 1 when no line matched/)
  assert.match(text, /\n\[exit code: 1\]$/)
  assert.equal(r.content[0].text, '(no output)\n[exit code: 1]', 'original result untouched')
})

test('decide leaves other tools, errors, blocks, value replacements and failures untouched', () => {
  const r = bashResult(1)
  const accept = { kind: 'accept' }
  assert.equal(decide(cfg, { name: 'read', arguments: { command: 'grep x' } }, r, accept), accept)
  assert.equal(decide(cfg, exec('grep x'), { ...r, isError: true }, accept), accept)
  const block = { kind: 'block', feedback: [] }
  assert.equal(decide(cfg, exec('grep x'), r, block), block)
  const val = { kind: 'accept', value: 1 }
  assert.equal(decide(cfg, exec('grep x'), r, val), val)
  assert.equal(decide(cfg, exec('npm test'), bashResult(1, '', 'fail'), accept), accept)
  const killed = bashResult(1); killed.value.signal = 'SIGKILL'
  assert.equal(decide(cfg, exec('grep x'), killed, accept), accept)
})

test('decide builds on content an earlier policy already replaced', () => {
  const r = bashResult(1)
  const d = decide(cfg, exec('diff a b'), r, { kind: 'accept', content: [{ type: 'text', text: '< a\n> b\n[exit code: 1]' }] })
  assert.match(d.content[0].text, /^< a\n> b\n\[exit-code note: diff exits 1/)
})

test('content-only results (persistent shell) are parsed from the marker', () => {
  const r = { isError: false, content: [{ type: 'text', text: 'x\n[stderr]\nboom\n[exit code: 1]' }] }
  assert.deepEqual(readOutcome(r), { exitCode: 1, stderr: 'boom' })
  assert.equal(annotate([{ type: 'text', text: 'no marker' }], 'n'), undefined)
})

test('end to end against real bash exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-'))
  writeFileSync(join(dir, 'a'), 'one\n'); writeFileSync(join(dir, 'b'), 'two\n')
  const run = cmd => {
    const p = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' })
    return decide(cfg, exec(cmd), bashResult(p.status, p.stdout, p.stderr), { kind: 'accept' })
  }
  const noted = d => /\[exit-code note:/.test(d.content?.[0]?.text ?? '')
  assert.ok(noted(run('grep -rn zzz_nomatch .')))
  assert.ok(noted(run('diff a b')))
  assert.ok(noted(run('test -e nope')))
  assert.ok(noted(run('cat a | grep zzz')))
  assert.ok(!noted(run('grep zzz missing-file')), 'exit 2 + stderr')
  assert.ok(!noted(run('ls nope')), 'ls failure')
  assert.ok(!noted(run('grep one a')), 'exit 0')
})
