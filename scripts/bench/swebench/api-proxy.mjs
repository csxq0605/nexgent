#!/usr/bin/env node
/**
 * The only way out of an isolated benchmark container: a plain-HTTP reverse
 * proxy to the model API, run by `run.mjs --network isolated` in a container
 * on both the internal network and the default bridge.
 *
 * - Forwards `/v1/*` to `NEXGENT_BENCH_UPSTREAM` (default
 *   `https://api.anthropic.com`), streaming both ways; every other path is 403.
 * - Holds the key: it drops the client's `x-api-key` / `authorization` and
 *   sets `x-api-key` from `NEXGENT_API_KEY` (or `ANTHROPIC_API_KEY`), so the
 *   task container only ever has a placeholder.
 * - Logs one line per request (method, path, status), never headers.
 */
import { createServer } from 'node:http'
import { request } from 'node:https'

const UPSTREAM = new URL(process.env.NEXGENT_BENCH_UPSTREAM ?? 'https://api.anthropic.com')
const PORT = Number(process.env.NEXGENT_BENCH_PROXY_PORT ?? '8080')
const KEY = process.env.NEXGENT_API_KEY || process.env.ANTHROPIC_API_KEY
if (KEY === undefined || KEY === '') {
  console.error('api-proxy: NEXGENT_API_KEY or ANTHROPIC_API_KEY is required')
  process.exit(2)
}

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200).end('ok')
    return
  }
  if (req.url === undefined || !req.url.startsWith('/v1/')) {
    res.writeHead(403).end('only /v1/ is forwarded')
    return
  }
  const headers = { ...req.headers, host: UPSTREAM.host }
  delete headers['x-api-key']
  delete headers.authorization
  delete headers.connection
  headers['x-api-key'] = KEY
  const upstream = request({ protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, method: req.method, path: req.url, headers }, response => {
    console.log(`${req.method} ${req.url} ${response.statusCode}`)
    res.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', error => {
    console.log(`${req.method} ${req.url} error ${error.code ?? error.message}`)
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
}).listen(PORT, '0.0.0.0', () => console.log(`api-proxy: listening on ${PORT}, forwarding to ${UPSTREAM.origin}`))
