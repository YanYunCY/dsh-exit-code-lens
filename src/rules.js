// Pure rules: which (command, exit code) pairs are an answer rather than a failure.
// Everything here is deterministic and side-effect free so it can be unit-tested.

/**
 * Built-in rules. `match(argv)` sees the words of the command that decided the
 * exit status (wrappers like `sudo`/`env`/`timeout` already removed).
 * `codes` lists the exit codes that mean "answered, nothing broke".
 */
export const BUILTIN_RULES = [
  { id: 'grep', match: a => ['grep', 'egrep', 'fgrep', 'zgrep'].includes(base(a[0])), codes: [1], note: '{cmd} exits 1 when no line matched. Nothing failed; the answer is "no matches".' },
  { id: 'rg', match: a => base(a[0]) === 'rg', codes: [1], note: 'rg exits 1 when nothing matched. Nothing failed; the answer is "no matches".' },
  { id: 'ag', match: a => ['ag', 'ack'].includes(base(a[0])), codes: [1], note: '{cmd} exits 1 when nothing matched. Nothing failed; the answer is "no matches".' },
  { id: 'git-grep', match: a => base(a[0]) === 'git' && gitSub(a) === 'grep', codes: [1], note: 'git grep exits 1 when nothing matched. Nothing failed; the answer is "no matches".' },
  { id: 'diff', match: a => ['diff', 'cmp', 'colordiff'].includes(base(a[0])), codes: [1], note: '{cmd} exits 1 when the inputs differ. Nothing failed; the output is the difference.' },
  { id: 'git-diff', match: a => base(a[0]) === 'git' && gitSub(a) === 'diff' && a.some(w => w === '--exit-code' || w === '--quiet'), codes: [1], note: 'git diff --exit-code/--quiet exits 1 when there are changes. Nothing failed.' },
  { id: 'test', match: a => ['test', '[', '[['].includes(a[0]), codes: [1], note: '{cmd} exits 1 when the condition is false. Nothing failed; the answer is "false".' },
  { id: 'which', match: a => ['which', 'type', 'hash'].includes(a[0]) || (a[0] === 'command' && (a[1] === '-v' || a[1] === '-V')), codes: [1], note: '{cmd} exits 1 when the command is not installed. Nothing failed; the answer is "not found".' },
  { id: 'pgrep', match: a => ['pgrep', 'pidof'].includes(base(a[0])), codes: [1], note: '{cmd} exits 1 when no process matched. Nothing failed; the answer is "not running".' },
  { id: 'git-ancestor', match: a => base(a[0]) === 'git' && gitSub(a) === 'merge-base' && a.includes('--is-ancestor'), codes: [1], note: 'git merge-base --is-ancestor exits 1 when it is not an ancestor. Nothing failed; the answer is "no".' },
  { id: 'jq-e', match: a => base(a[0]) === 'jq' && a.some(w => w === '-e' || w === '--exit-status' || /^-[a-zA-Z]*e[a-zA-Z]*$/.test(w)), codes: [1], note: 'jq -e exits 1 when the last output is false or null. Nothing failed.' },
  { id: 'false', match: a => a[0] === 'false', codes: [1], note: 'false always exits 1.' },
]

const WRAPPERS = new Set(['sudo', 'doas', 'nice', 'nohup', 'time', 'command', 'builtin', 'exec', 'stdbuf', 'ionice'])

function base(word) {
  if (typeof word !== 'string') return ''
  const i = word.lastIndexOf('/')
  return i === -1 ? word : word.slice(i + 1)
}

function gitSub(argv) {
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') { i++; continue }
    if (w.startsWith('-')) continue
    return w
  }
  return undefined
}

/**
 * Split a shell command into top-level segments. Only quoting, escapes,
 * `$(...)`/backticks and parentheses are tracked; this is a lexer, not a shell.
 * @returns {{ segments: {words: string[], sep: string|null}[][], complex: boolean }}
 *   segments: list of pipelines (each a list of simple commands); sep is the
 *   operator that FOLLOWS that pipeline. complex: true when we met syntax we
 *   do not try to reason about (subshells, heredocs, control keywords).
 */
export function lex(command) {
  const pipelines = []
  let pipeline = []
  let words = []
  let word = ''
  let inWord = false
  let complex = false
  let depth = 0
  const pushWord = () => { if (inWord) { words.push(word); word = ''; inWord = false } }
  const pushCmd = () => { pushWord(); pipeline.push(words); words = [] }
  const pushPipe = sep => { pushCmd(); pipelines.push({ cmds: pipeline, sep }); pipeline = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const n = command[i + 1]
    if (c === '\\') { word += n ?? ''; inWord = true; i++; continue }
    if (c === "'") { const j = command.indexOf("'", i + 1); if (j === -1) { complex = true; break } word += command.slice(i + 1, j); inWord = true; i = j; continue }
    if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') { if (command[j] === '\\') j++; j++ }
      if (j >= command.length) { complex = true; break }
      word += command.slice(i + 1, j); inWord = true; i = j; continue
    }
    if (c === '`') { const j = command.indexOf('`', i + 1); if (j === -1) { complex = true; break } word += command.slice(i, j + 1); inWord = true; i = j; continue }
    if (c === '$' && n === '(') {
      let d = 0, j = i + 1
      for (; j < command.length; j++) { if (command[j] === '(') d++; else if (command[j] === ')' && --d === 0) break }
      word += command.slice(i, j + 1); inWord = true; i = j; continue
    }
    if (c === '(' || c === ')' || c === '{' && !inWord && (n === ' ' || n === '\n')) { complex = true; depth += c === '(' ? 1 : 0; pushWord(); continue }
    if (c === '<' && n === '<') { complex = true }
    if (c === '#' && !inWord) { const j = command.indexOf('\n', i); if (j === -1) break; i = j - 1; continue }
    if (c === '|' && n === '|') { pushPipe('||'); i++; continue }
    if (c === '&' && n === '&') { pushPipe('&&'); i++; continue }
    if (c === '|' && n === '&') { pushCmd(); i++; continue }
    if (c === '|') { pushCmd(); continue }
    if (c === ';' || c === '\n') { pushPipe(';'); continue }
    if (c === '&' && n !== '>' && command[i - 1] !== '>') { pushPipe('&'); continue }
    if (c === ' ' || c === '\t') { pushWord(); continue }
    word += c; inWord = true
  }
  pushPipe(null)
  const cleaned = pipelines
    .map(p => ({ cmds: p.cmds.map(stripRedirects).filter(w => w.length > 0), sep: p.sep }))
    .filter(p => p.cmds.length > 0)
  const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', '!'])
  if (cleaned.some(p => p.cmds.some(c => KEYWORDS.has(c[0])))) complex = true
  return { pipelines: cleaned, complex: complex || depth > 0 }
}

function stripRedirects(words) {
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^\d*(>>?|<|&>>?|>&|<&|<<<)$/.test(w)) { i++; continue }
    if (/^\d*(>>?|<|&>>?|>&|<&)\S+$/.test(w)) continue
    out.push(w)
  }
  return out
}

/** Remove leading VAR=x assignments and wrapper commands like sudo/env/timeout. */
export function unwrap(argv) {
  let a = argv.slice()
  for (let guard = 0; guard < 8 && a.length > 0; guard++) {
    while (a.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift()
    const head = base(a[0])
    if (head === 'env') { a.shift(); while (a.length > 0 && (a[0].startsWith('-') || a[0].includes('='))) a.shift(); continue }
    if (head === 'timeout') { a.shift(); while (a.length > 0 && a[0].startsWith('-')) a.shift(); a.shift(); continue }
    if (head === 'xargs') return a // xargs maps child exit 1-125 to 123; not a plain rule
    if (WRAPPERS.has(head) && !(head === 'command' && (a[1] === '-v' || a[1] === '-V'))) {
      a.shift()
      while (a.length > 0 && a[0].startsWith('-')) {
        const opt = a.shift()
        // `nice -n 5`, `ionice -c 2`: a short option followed by its numeric value
        if (/^-[a-zA-Z]$/.test(opt) && a.length > 0 && /^-?\d+$/.test(a[0])) a.shift()
      }
      continue
    }
    break
  }
  return a
}

/**
 * Decide whether an exit code is an answer rather than a failure.
 * @param {string} command - the full shell command the tool ran.
 * @param {number} exitCode - the status the tool reported.
 * @param {{ stderr?: string, rules?: object[] }} [opts]
 * @returns {{ rule: string, note: string } | undefined}
 */
export function explain(command, exitCode, opts = {}) {
  if (typeof command !== 'string' || !Number.isInteger(exitCode) || exitCode === 0) return undefined
  // A message on stderr means something may really have gone wrong (grep exits 2
  // on errors, but `grep pat missing-file` with -s style output still deserves a look).
  if (opts.stderr !== undefined && opts.stderr.trim().length > 0) return undefined
  const { pipelines, complex } = lex(command)
  if (complex || pipelines.length === 0) return undefined
  // Background jobs and `||` change which command owns the status.
  if (pipelines.some(p => p.sep === '&' || p.sep === '||')) return undefined
  const last = pipelines[pipelines.length - 1]
  const decider = unwrap(last.cmds[last.cmds.length - 1])
  if (decider.length === 0) return undefined
  const rules = [...(opts.rules ?? []).map(compileUserRule), ...BUILTIN_RULES]
  for (const rule of rules) {
    if (!rule.codes.includes(exitCode)) continue
    if (!rule.match(decider)) continue
    const cmd = rule.id === 'test' ? (decider[0] === 'test' ? 'test' : decider[0]) : base(decider[0])
    let note = rule.note.replaceAll('{cmd}', cmd).replaceAll('{code}', String(exitCode))
    // With a pipeline or an earlier `&&`/`;` step the status could, rarely, come
    // from somewhere else (pipefail); say so instead of overclaiming.
    if (pipelines.length > 1 || last.cmds.length > 1) note += ' (Assuming the status came from the last command.)'
    return { rule: rule.id, note }
  }
  return undefined
}

/** User rules from config: { command: 'mytool' | ['a','b'], subcommand?, codes: [n], note } */
export function compileUserRule(r) {
  const names = Array.isArray(r.command) ? r.command : [r.command]
  return {
    id: `user:${names.join(',')}${r.subcommand ? ' ' + r.subcommand : ''}`,
    codes: r.codes,
    note: r.note,
    match: a => names.includes(base(a[0])) && (r.subcommand === undefined || a[1] === r.subcommand),
  }
}
