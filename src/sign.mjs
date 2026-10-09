import { createHmac, randomUUID } from 'node:crypto'

// Standard Webhooks v1 signature: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)).
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md

/**
 * @param {{ secret: Uint8Array, id: string, timestamp: number, body: string }} input
 *   `timestamp` is in whole seconds since the epoch.
 */
export function signStandardWebhook({ secret, id, timestamp, body }) {
  const digest = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')
  return `v1,${digest}`
}

/**
 * @param {{ secret: Uint8Array, body: string, now?: () => number }} input
 * @returns {Record<string, string>}
 */
export function standardWebhookHeaders({ secret, body, now = Date.now }) {
  const id = `msg_${randomUUID()}`
  const timestamp = Math.floor(now() / 1000)
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signStandardWebhook({ secret, id, timestamp, body })
  }
}
