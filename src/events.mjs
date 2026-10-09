// Turns Orca `agent.status.changed` payloads into relay messages.

const DEDUPE_PANE_LIMIT = 1024

/**
 * The state the relay reports. `mainAgent.state` wins over the combined
 * `state`: the combined state stays `working` while a background task or
 * subagent runs, even after the main agent's turn has ended.
 *
 * @param {{ state: string, mainAgent?: { state: string } }} payload
 */
export function relayKind(payload) {
  return payload.mainAgent?.state ?? payload.state
}

/**
 * Orca delivers the same status several times in a row. Emit only when a
 * pane's (kind, stateStartedAt) pair changes.
 */
export function createDeduper(limit = DEDUPE_PANE_LIMIT) {
  /** @type {Map<string, string>} */
  const lastByPane = new Map()
  return {
    /** @param {{ paneKey: string, state: string, mainAgent?: { state: string, stateStartedAt?: number } }} payload */
    shouldEmit(payload) {
      const signature = `${relayKind(payload)}|${payload.mainAgent?.stateStartedAt ?? ''}`
      if (lastByPane.get(payload.paneKey) === signature) {
        return false
      }
      // Re-insert so Map order tracks recency for eviction.
      lastByPane.delete(payload.paneKey)
      lastByPane.set(payload.paneKey, signature)
      if (lastByPane.size > limit) {
        lastByPane.delete(lastByPane.keys().next().value)
      }
      return true
    }
  }
}

/**
 * `paneKey` is `<tabId>:<leafId>`, the same pair `orca terminal list --json`
 * reports per terminal, so a receiver can resolve the terminal handle.
 *
 * @param {string} paneKey
 */
export function splitPaneKey(paneKey) {
  const parts = paneKey.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { tabId: null, leafId: null }
  }
  return { tabId: parts[0], leafId: parts[1] }
}

/** @param {{ worktreeId: string | null, paneKey: string, state: string, receivedAt: number, mainAgent?: object }} payload */
export function buildStatusMessage(payload) {
  return {
    type: 'agent.status.changed',
    kind: relayKind(payload),
    worktreeId: payload.worktreeId,
    paneKey: payload.paneKey,
    ...splitPaneKey(payload.paneKey),
    state: payload.state,
    mainAgent: payload.mainAgent ?? null,
    receivedAt: payload.receivedAt
  }
}
