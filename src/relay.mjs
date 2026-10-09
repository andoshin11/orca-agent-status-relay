import { ConfigError, loadConfig } from './config.mjs'
import { deliver } from './deliver.mjs'
import { buildStatusMessage, createDeduper, relayKind } from './events.mjs'

// Why: Orca SIGKILLs a worker with 64 unacknowledged events or one event older
// than 5 minutes, and reaps it 5 minutes after its last host activity. Event
// handlers therefore return at once, and the backlog is capped so it drains
// well inside those windows (20 × 5 s timeout = 100 s worst case).
export const MAX_PENDING_DELIVERIES = 20

/**
 * @param {{
 *   configPath: string,
 *   log: (line: string) => void,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   maxPending?: number
 * }} options
 */
export function createRelay({ configPath, log, fetchImpl, now, maxPending = MAX_PENDING_DELIVERIES }) {
  const deduper = createDeduper()
  /** @type {object[]} */
  const pending = []
  /** @type {Promise<void> | null} */
  let draining = null

  const readConfig = async () => {
    try {
      return await loadConfig(configPath)
    } catch (error) {
      if (error instanceof ConfigError) {
        log(`config error (${error.code}): ${error.message}`)
        return null
      }
      log(`config error (unexpected): ${error?.name ?? 'unknown'}`)
      return null
    }
  }

  const sendStatus = async (payload) => {
    // Read on every event so edits to the file apply without reloading the plugin.
    const config = await readConfig()
    if (!config) {
      return
    }
    const kind = relayKind(payload)
    if (!config.states.includes(kind)) {
      return
    }
    const result = await deliver({
      url: config.url,
      secret: config.secret,
      message: buildStatusMessage(payload),
      fetchImpl,
      now
    })
    logResult(log, `kind=${kind}`, result)
  }

  // One delivery at a time, so a receiver sees a pane's transitions in the
  // order Orca produced them.
  const drain = async () => {
    while (pending.length > 0) {
      const payload = pending.shift()
      try {
        await sendStatus(payload)
      } catch (error) {
        log(`delivery error (unexpected): ${error?.name ?? 'unknown'}`)
      }
    }
    draining = null
  }

  return {
    /**
     * Accepts one `agent.status.changed` payload and returns immediately;
     * delivery happens in the background.
     *
     * @returns {'queued' | 'duplicate'}
     */
    handleStatus(payload) {
      if (!deduper.shouldEmit(payload)) {
        return 'duplicate'
      }
      pending.push(payload)
      if (pending.length > maxPending) {
        const dropped = pending.shift()
        log(`dropped kind=${relayKind(dropped)}: more than ${maxPending} deliveries pending`)
      }
      draining ??= drain()
      return 'queued'
    },

    /** Resolves once every queued delivery has finished. */
    idle() {
      return draining ?? Promise.resolve()
    },

    /**
     * Sends a `relay.test` message right away, outside the status queue, so
     * the command answers within Orca's invoke timeout.
     */
    async sendTest() {
      const config = await readConfig()
      if (!config) {
        return { ok: false, reason: 'config' }
      }
      const result = await deliver({
        url: config.url,
        secret: config.secret,
        message: { type: 'relay.test', sentAt: (now ?? Date.now)() },
        fetchImpl,
        now
      })
      logResult(log, 'test', result)
      return result
    }
  }
}

function logResult(log, label, result) {
  if (result.ok) {
    log(`sent ${label} status=${result.status}`)
  } else if ('status' in result) {
    log(`failed ${label} reason=${result.reason} status=${result.status}`)
  } else {
    log(`failed ${label} reason=${result.reason} (${result.detail})`)
  }
}
