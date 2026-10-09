// Minimal receiver that verifies Standard Webhooks signatures and prints each message.
//
//   RELAY_SECRET='whsec_...' node examples/receiver.mjs 47821
//
// It listens on 127.0.0.1 only. Use it to check the relay end to end before
// pointing the plugin at a real service.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const TOLERANCE_SECONDS = 5 * 60
const MAX_BODY_BYTES = 64 * 1024

/**
 * @param {{ secret: string, headers: Record<string, string | string[] | undefined>, body: string, now?: () => number }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyStandardWebhook({ secret, headers, body, now = Date.now }) {
  const id = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  const signatures = headers['webhook-signature']
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string') {
    return { ok: false, reason: 'missing webhook headers' }
  }
  const seconds = Number(timestamp)
  if (!Number.isInteger(seconds) || Math.abs(now() / 1000 - seconds) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp outside tolerance' }
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()
  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) {
      continue
    }
    const actual = Buffer.from(value, 'base64')
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'signature mismatch' }
}

/**
 * Replay protection (remembering `webhook-id`s inside the tolerance window) is
 * left to real receivers; this example only verifies the signature and time.
 *
 * @param {{ secret: string, port: number, onMessage: (message: unknown) => void }} options
 */
export function startReceiver({ secret, port, onMessage }) {
  const server = createServer((req, res) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const verdict = verifyStandardWebhook({ secret, headers: req.headers, body })
      if (!verdict.ok) {
        console.error(`rejected: ${verdict.reason}`)
        res.writeHead(401).end()
        return
      }
      let message
      try {
        message = JSON.parse(body)
      } catch {
        res.writeHead(400).end()
        return
      }
      onMessage(message)
      res.writeHead(204).end()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.RELAY_SECRET
  if (!secret) {
    console.error('RELAY_SECRET is required')
    process.exit(1)
  }
  const port = Number(process.argv[2] ?? 47821)
  const server = await startReceiver({
    secret,
    port,
    onMessage: (message) => console.log(JSON.stringify(message))
  })
  console.error(`listening on http://127.0.0.1:${server.address().port}`)
}
