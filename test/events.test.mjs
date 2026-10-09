import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatusMessage, createDeduper, relayKind, splitPaneKey } from '../src/events.mjs'

const PANE = '246b9bd7-b321-43eb-a9bd-fc647033872c:ced1b7cf-a318-44fb-8031-2d40bdea9f50'

function status(state, mainState, stateStartedAt, paneKey = PANE) {
  return {
    worktreeId: 'repo::/path/to/worktree',
    paneKey,
    state,
    receivedAt: 1791556042619,
    ...(mainState ? { mainAgent: { state: mainState, stateStartedAt } } : {})
  }
}

test('prefers the main agent state over the combined state', () => {
  // Observed in Orca 1.4.223: a background task keeps the combined state working after the turn ends.
  assert.equal(relayKind(status('working', 'done', 2)), 'done')
  assert.equal(relayKind(status('waiting', 'waiting', 3)), 'waiting')
  assert.equal(relayKind(status('blocked')), 'blocked')
})

test('drops repeated deliveries of the same state', () => {
  const deduper = createDeduper()
  assert.equal(deduper.shouldEmit(status('working', 'working', 1)), true)
  assert.equal(deduper.shouldEmit(status('working', 'working', 1)), false)
  assert.equal(deduper.shouldEmit(status('working', 'done', 2)), true)
  assert.equal(deduper.shouldEmit(status('working', 'done', 2)), false)
  // A new turn reaching the same state again has a new stateStartedAt.
  assert.equal(deduper.shouldEmit(status('working', 'working', 3)), true)
  assert.equal(deduper.shouldEmit(status('done', 'done', 4)), true)
})

test('tracks panes independently', () => {
  const deduper = createDeduper()
  assert.equal(deduper.shouldEmit(status('done', 'done', 1, 'a:1')), true)
  assert.equal(deduper.shouldEmit(status('done', 'done', 1, 'b:1')), true)
  assert.equal(deduper.shouldEmit(status('done', 'done', 1, 'a:1')), false)
})

test('suppresses consecutive duplicates when mainAgent is absent', () => {
  const deduper = createDeduper()
  assert.equal(deduper.shouldEmit(status('waiting')), true)
  assert.equal(deduper.shouldEmit(status('waiting')), false)
  assert.equal(deduper.shouldEmit(status('working')), true)
})

test('evicts the least recently seen pane beyond the limit', () => {
  const deduper = createDeduper(2)
  deduper.shouldEmit(status('done', 'done', 1, 'a:1'))
  deduper.shouldEmit(status('done', 'done', 1, 'b:1'))
  deduper.shouldEmit(status('done', 'done', 1, 'c:1'))
  // a:1 was evicted, so the same state is emitted again.
  assert.equal(deduper.shouldEmit(status('done', 'done', 1, 'a:1')), true)
  assert.equal(deduper.shouldEmit(status('done', 'done', 1, 'c:1')), false)
})

test('splits paneKey into tabId and leafId', () => {
  assert.deepEqual(splitPaneKey('tab:leaf'), { tabId: 'tab', leafId: 'leaf' })
  assert.deepEqual(splitPaneKey('no-separator'), { tabId: null, leafId: null })
  assert.deepEqual(splitPaneKey('a:b:c'), { tabId: null, leafId: null })
  assert.deepEqual(splitPaneKey(':leaf'), { tabId: null, leafId: null })
})

test('builds the relay message', () => {
  assert.deepEqual(buildStatusMessage(status('working', 'done', 5)), {
    type: 'agent.status.changed',
    kind: 'done',
    worktreeId: 'repo::/path/to/worktree',
    paneKey: PANE,
    tabId: '246b9bd7-b321-43eb-a9bd-fc647033872c',
    leafId: 'ced1b7cf-a318-44fb-8031-2d40bdea9f50',
    state: 'working',
    mainAgent: { state: 'done', stateStartedAt: 5 },
    receivedAt: 1791556042619
  })
  assert.equal(buildStatusMessage(status('blocked')).mainAgent, null)
})
