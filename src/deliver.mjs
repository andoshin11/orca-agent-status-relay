import { standardWebhookHeaders } from './sign.mjs'

export const DELIVERY_TIMEOUT_MS = 5000

/**
 * Sends one signed POST. Exactly one attempt: a failure is reported, never
 * retried, because a timed-out request may already have been accepted.
 * Results carry no URL, body or secret so they are safe to log.
 *
 * @param {{
 *   url: URL,
 *   secret: Uint8Array,
 *   message: object,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: () => number
 * }} input
 * @returns {Promise<
 *   | { ok: true, status: number }
 *   | { ok: false, reason: 'http_status' | 'redirect', status: number }
 *   | { ok: false, reason: 'timeout' | 'network', detail: string }
 * >}
 */
export async function deliver({
  url,
  secret,
  message,
  fetchImpl = fetch,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  now = Date.now
}) {
  const body = JSON.stringify(message)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...standardWebhookHeaders({ secret, body, now })
      },
      body,
      // Why: following a redirect would send the signed event to a host the
      // user never configured.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `no response within ${timeoutMs}ms` }
    }
    return {
      ok: false,
      reason: 'network',
      detail: String(error?.cause?.code ?? error?.cause?.name ?? error?.name ?? 'unknown')
    }
  }
  // The receiver's body is never used; cancel instead of reading it so an
  // untrusted endpoint cannot make the worker buffer a large response.
  await response.body?.cancel().catch(() => undefined)
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: 'redirect', status: response.status }
  }
  if (!response.ok) {
    return { ok: false, reason: 'http_status', status: response.status }
  }
  return { ok: true, status: response.status }
}
