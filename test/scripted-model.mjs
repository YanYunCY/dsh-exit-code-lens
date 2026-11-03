// Minimal OpenAI chat-completions mock: 1st request -> bash tool call, 2nd -> log what the model would see.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const [port, log, command] = [Number(process.argv[2]), process.argv[3], process.argv[4] ?? 'grep -rn zzz_no_such_text_zzz .']
writeFileSync(log, '')
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end('data: [DONE]\n\n')
}
const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-sonnet' }
createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"mock-sonnet"}]}') }
    const j = JSON.parse(body)
    const sys = j.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
    const tool = j.messages.filter(m => m.role === 'tool')
    if (tool.length === 0) {
      appendFileSync(log, `SYSTEM_HAS_LENS=${sys.includes('[exit-code note]')}\n`)
      return sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] } }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ description: 'Search for text', command }) } }] } }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ])
    }
    const c = tool[tool.length - 1].content
    appendFileSync(log, `TOOL_RESULT<<\n${typeof c === 'string' ? c : JSON.stringify(c)}\n>>\n`)
    sse(res, [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'DONE' } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ])
  })
}).listen(port, '127.0.0.1')
