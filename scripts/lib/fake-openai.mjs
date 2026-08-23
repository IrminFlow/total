/**
 * A minimal OpenAI-compatible server for tests. Dependency-free `node:http`.
 *
 * Exercising the real SDK against this — rather than injecting a fake transport — is deliberate:
 * it covers the SSE parsing, retry and abort plumbing that an injected client would skip, which
 * is exactly where a streaming bug hides.
 *
 * Every request is recorded, so a test can assert on what was SENT. That is how the redaction
 * and egress guarantees are checked: post a voucher with a GSTIN, ask a question, then assert
 * the GSTIN appears nowhere in the recorded bodies.
 */
import http from 'node:http'

const MODELS = ['fake-small', 'fake-large']

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunk(delta, finish) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-small',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }]
  }
}

/**
 * @param {{ script?: Array<object> }} [opts] Queue of scripted replies, consumed one per request.
 *   { kind: 'text', text }                  stream text then stop
 *   { kind: 'tool', calls: [{name, args}] } stream tool calls
 *   { kind: 'error', status, body }         reply with an HTTP error
 *   { kind: 'hang', ms }                    stall, for abort/timeout tests
 */
export async function startFakeOpenAi(opts = {}) {
  const script = [...(opts.script ?? [])]
  const requests = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      const parsed = body ? JSON.parse(body) : null
      requests.push({ url: req.url, method: req.method, body: parsed, raw: body })

      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
        return
      }

      const step = script.shift() ?? { kind: 'text', text: 'No script left.' }

      if (step.kind === 'error') {
        res.writeHead(step.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify(step.body ?? { error: { message: 'fake error' } }))
        return
      }

      if (step.kind === 'hang') {
        await new Promise((r) => setTimeout(r, step.ms ?? 5000))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })

      if (step.kind === 'tool') {
        step.calls.forEach((call, index) => {
          sse(
            res,
            chunk({
              tool_calls: [
                {
                  index,
                  id: `call_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
                }
              ]
            })
          )
        })
        sse(res, chunk({}, 'tool_calls'))
      } else {
        // Split into several chunks so the coalescer and SSE parser both get exercised.
        for (const piece of String(step.text).match(/.{1,12}/gs) ?? []) {
          sse(res, chunk({ content: piece }))
        }
        sse(res, chunk({}, 'stop'))
      }

      sse(res, {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-small',
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    /** Every request body serialized — for "this string was never sent" assertions. */
    sentText: () => JSON.stringify(requests),
    push: (step) => script.push(step),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
