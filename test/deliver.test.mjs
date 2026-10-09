import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { startReceiver } from '../examples/receiver.mjs'
import { deliver } from '../src/deliver.mjs'
import { standardWebhookHeaders } from '../src/sign.mjs'

const SECRET_TEXT = `whsec_${Buffer.alloc(32, 3).toString('base64')}`
const SECRET = new Uint8Array(Buffer.from(SECRET_TEXT.slice(6), 'base64'))

const servers = []
after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))))

function listen(handler) {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const urlOf = (server, path = '/hook') => new URL(`http://127.0.0.1:${server.address().port}${path}`)

test('delivers a message the receiver can verify', async () => {
  const received = []
  const server = await startReceiver({ secret: SECRET_TEXT, port: 0, onMessage: (m) => received.push(m) })
  servers.push(server)
  const result = await deliver({ url: urlOf(server), secret: SECRET, message: { type: 'relay.test' } })
  assert.deepEqual(result, { ok: true, status: 204 })
  assert.deepEqual(received, [{ type: 'relay.test' }])
})

test('a wrong secret is rejected by the receiver and reported as http_status', async () => {
  const server = await startReceiver({ secret: SECRET_TEXT, port: 0, onMessage: () => assert.fail() })
  servers.push(server)
  const otherSecret = new Uint8Array(32).fill(4)
  const result = await deliver({ url: urlOf(server), secret: otherSecret, message: { type: 'x' } })
  assert.deepEqual(result, { ok: false, reason: 'http_status', status: 401 })
})

test('does not follow redirects', async () => {
  let redirectedHits = 0
  let redirectStatus = 0
  const server = await listen((req, res) => {
    if (req.url === '/elsewhere') {
      redirectedHits += 1
      res.writeHead(204).end()
      return
    }
    res.writeHead(redirectStatus, { location: '/elsewhere' }).end()
  })
  for (const code of [301, 302, 303, 307, 308]) {
    redirectStatus = code
    const result = await deliver({ url: urlOf(server), secret: SECRET, message: {} })
    assert.deepEqual(result, { ok: false, reason: 'redirect', status: code })
  }
  assert.equal(redirectedHits, 0)
})

test('reports a server error status', async () => {
  const server = await listen((_req, res) => res.writeHead(503).end('busy'))
  assert.deepEqual(await deliver({ url: urlOf(server), secret: SECRET, message: {} }), {
    ok: false,
    reason: 'http_status',
    status: 503
  })
})

test('times out instead of waiting forever', async () => {
  const server = await listen(() => {
    // Never respond.
  })
  const result = await deliver({ url: urlOf(server), secret: SECRET, message: {}, timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  server.closeAllConnections()
})

test('reports network failures by their cause', async () => {
  const failWith = (cause) => async () => {
    throw new TypeError('fetch failed', { cause })
  }
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  assert.deepEqual(await deliver({ url: new URL('https://example.com'), secret: SECRET, message: {}, fetchImpl: failWith(refused) }), {
    ok: false,
    reason: 'network',
    detail: 'ECONNREFUSED'
  })
  // A cause without a code is still named, instead of the generic TypeError.
  const tls = new SyntaxError('bad certificate')
  assert.deepEqual(await deliver({ url: new URL('https://example.com'), secret: SECRET, message: {}, fetchImpl: failWith(tls) }), {
    ok: false,
    reason: 'network',
    detail: 'SyntaxError'
  })
})

test('the receiver answers 400 to a signed non-JSON body', async () => {
  const server = await startReceiver({ secret: SECRET_TEXT, port: 0, onMessage: () => assert.fail() })
  servers.push(server)
  const response = await fetch(urlOf(server), {
    method: 'POST',
    headers: standardWebhookHeaders({ secret: SECRET, body: 'not json' }),
    body: 'not json'
  })
  assert.equal(response.status, 400)
})
