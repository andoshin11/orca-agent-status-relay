import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyStandardWebhook } from '../examples/receiver.mjs'
import { signStandardWebhook, standardWebhookHeaders } from '../src/sign.mjs'

test('matches the Standard Webhooks reference vector', () => {
  // From the standard-webhooks specification's reference implementation tests.
  const secret = Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64')
  const signature = signStandardWebhook({
    secret,
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: 1614265330,
    body: '{"test": 2432232314}'
  })
  assert.equal(signature, 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
})

test('headers verify with the example receiver and fail when tampered', () => {
  const secretText = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
  const secret = Buffer.from(secretText.slice(6), 'base64')
  const body = '{"type":"relay.test"}'
  const now = () => 1_700_000_000_000
  const headers = standardWebhookHeaders({ secret, body, now })

  assert.match(headers['webhook-id'], /^msg_[0-9a-f-]{36}$/)
  assert.equal(headers['webhook-timestamp'], '1700000000')
  assert.deepEqual(verifyStandardWebhook({ secret: secretText, headers, body, now }), { ok: true })
  assert.equal(verifyStandardWebhook({ secret: secretText, headers, body: `${body} `, now }).ok, false)
  assert.equal(
    verifyStandardWebhook({ secret: secretText, headers, body, now: () => now() + 10 * 60 * 1000 }).ok,
    false
  )
})
