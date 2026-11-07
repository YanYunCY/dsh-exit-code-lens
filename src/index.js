// dsh-exit-code-lens: tell the model when a non-zero exit code is an answer
// (grep found nothing, diff found differences, test was false) rather than a failure,
// so it stops re-verifying commands that worked.
import Schema from '@deepseek-ai/schemastery'
import { explain } from './rules.js'

export { explain, lex, unwrap, BUILTIN_RULES } from './rules.js'

export const name = 'dsh-exit-code-lens'
export const inject = ['tools', 'systemPrompt']

export const Config = Schema.object({
  tools: Schema.array(String).default(['bash']).description('Tool names whose results are annotated.'),
  prompt: Schema.boolean().default(true).description('Add one system-prompt line explaining that some exit codes are answers, not failures.'),
  rules: Schema.array(Schema.object({
    command: Schema.union([String, Schema.array(String)]).required().description('Command name(s), e.g. "mytool".'),
    subcommand: Schema.string().description('Optional first argument, e.g. "check".'),
    codes: Schema.array(Schema.natural()).required().description('Exit codes that mean "answered, nothing broke".'),
    note: Schema.string().required().description('Text shown to the model. {cmd} and {code} are replaced.'),
  })).default([]).description('Extra rules, checked before the built-in ones.'),
})

export const PROMPT_TEXT = 'Some commands use a non-zero exit code to report an answer, not a failure: grep/rg exit 1 for "no matches", diff/cmp exit 1 for "files differ", test/[ exit 1 for "false", which/pgrep exit 1 for "not found". When a bash result carries an [exit-code note], trust it and move on instead of re-running or investigating the command.'

const EXIT_RE = /\n?\[exit code: (-?\d+)\]\s*$/

/** Read exit code and stderr from a bash result (value first, content as fallback). */
export function readOutcome(result) {
  const v = result.value
  if (v && typeof v === 'object' && v.kind === 'foreground') {
    return { exitCode: v.exitCode, stderr: v.stderr?.text ?? '', signal: v.signal, timedOut: v.timedOut }
  }
  const text = lastText(result.content)
  if (text === undefined) return undefined
  const m = EXIT_RE.exec(text)
  if (!m) return undefined
  const i = text.indexOf('[stderr]\n')
  return { exitCode: Number(m[1]), stderr: i === -1 ? '' : text.slice(i + 9, m.index) }
}

function lastText(content) {
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) if (content[i]?.type === 'text') return content[i].text
  return undefined
}

/**
 * Insert the note just above the `[exit code: N]` marker. The marker stays the
 * last line, because the terminal card parses it from there.
 * @returns new content, or undefined when the marker was not found.
 */
export function annotate(content, note) {
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i]
    if (b?.type !== 'text') continue
    const m = EXIT_RE.exec(b.text)
    if (!m) return undefined
    const head = b.text.slice(0, m.index)
    if (/(^|\n)\[exit-code note: [^\n]*\]$/.test(head)) return undefined // already annotated
    const text = `${head}${head ? '\n' : ''}[exit-code note: ${note}]\n[exit code: ${m[1]}]`
    const next = content.slice()
    next[i] = { ...b, text }
    return next
  }
  return undefined
}

/** The post-execute decision for one call, as a pure function for testing. */
export function decide(config, exec, result, decision) {
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
  if (!(config.tools ?? ['bash']).includes(exec.name) || result.isError) return decision
  const command = exec.arguments?.command
  if (typeof command !== 'string') return decision
  const outcome = readOutcome(result)
  if (!outcome || outcome.signal || outcome.timedOut) return decision
  const hit = explain(command, outcome.exitCode, { stderr: outcome.stderr, rules: config.rules })
  if (!hit) return decision
  const content = annotate(decision.content ?? result.content, hit.note)
  if (!content) return decision
  return { ...decision, kind: 'accept', content }
}

export function apply(ctx, config) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      return decide(config, exec, result, decision)
    } catch {
      return decision // never break a tool result because of an annotation
    }
  })
  if (config.prompt !== false) {
    ctx.systemPrompt.section({
      name: 'exit-code-lens',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 0.5,
      text: PROMPT_TEXT,
    })
  }
}
