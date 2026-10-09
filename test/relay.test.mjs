import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import activate from '../main.mjs'
import { createRelay } from '../src/relay.mjs'

const SECRET = `whsec_${Buffer.alloc(32, 5).toString('base64')}`

async function configFile(value) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'))
  const path = join(dir, 'config.json')
  await writeConfig(path, value)
  return path
}

async function writeConfig(path, value) {
  await writeFile(path, JSON.stringify(value))
  await chmod(path, 0o600)
}

function recordingFetch(status = 204) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return new Response(null, { status })
  }
  return { calls, fetchImpl }
}

/** A fetch whose responses are released one at a time by the test. */
function heldFetch() {
  const calls = []
  const releases = []
  const fetchImpl = (_url, init) => {
    calls.push(JSON.parse(init.body).kind)
    return new Promise((resolve) => releases.push(() => resolve(new Response(null, { status: 204 }))))
  }
  return { calls, releases, fetchImpl }
}

const status = (state, mainState, stateStartedAt, paneKey = 'tab:leaf') => ({
  worktreeId: 'w',
  paneKey,
  state,
  receivedAt: 1,
  mainAgent: { state: mainState, stateStartedAt }
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('sends deduplicated, filtered transitions', async () => {
  const configPath = await configFile({ url: 'https://example.com/hook', secret: SECRET })
  const { calls, fetchImpl } = recordingFetch()
  const logs = []
  const relay = createRelay({ configPath, fetchImpl, log: (line) => logs.push(line) })

  const accepted = [
    relay.handleStatus(status('working', 'working', 1)),
    relay.handleStatus(status('working', 'working', 1)),
    relay.handleStatus(status('waiting', 'waiting', 2)),
    relay.handleStatus(status('working', 'working', 3)),
    relay.handleStatus(status('working', 'done', 4)),
    relay.handleStatus(status('working', 'done', 4))
  ]
  await relay.idle()

  assert.deepEqual(accepted, ['queued', 'duplicate', 'queued', 'queued', 'queued', 'duplicate'])
  assert.deepEqual(
    calls.map((c) => c.body.kind),
    ['waiting', 'done']
  )
  assert.equal(calls[0].url, 'https://example.com/hook')
  assert.match(calls[0].headers['webhook-signature'], /^v1,/)
  assert.deepEqual(logs, ['sent kind=waiting status=204', 'sent kind=done status=204'])
})

test('delivers one at a time, in arrival order', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET })
  const { calls, releases, fetchImpl } = heldFetch()
  const relay = createRelay({ configPath, fetchImpl, log: () => {} })

  relay.handleStatus(status('done', 'done', 1, 'a:1'))
  relay.handleStatus(status('waiting', 'waiting', 1, 'b:1'))
  while (calls.length < 1) await tick()
  // The second delivery must not start while the first is still in flight.
  await tick()
  assert.deepEqual(calls, ['done'])

  releases[0]()
  while (calls.length < 2) await tick()
  assert.deepEqual(calls, ['done', 'waiting'])
  releases[1]()
  await relay.idle()
})

test('returns before delivery finishes', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET })
  const { releases, fetchImpl } = heldFetch()
  const relay = createRelay({ configPath, fetchImpl, log: () => {} })
  assert.equal(relay.handleStatus(status('done', 'done', 1)), 'queued')
  while (releases.length < 1) await tick()
  releases[0]()
  await relay.idle()
})

test('drops the oldest pending delivery beyond the limit', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET, states: ['done'] })
  const { calls, releases, fetchImpl } = heldFetch()
  const logs = []
  const relay = createRelay({ configPath, fetchImpl, log: (l) => logs.push(l), maxPending: 2 })

  relay.handleStatus(status('done', 'done', 1, 'p:1'))
  while (calls.length < 1) await tick()
  // p:1 is in flight; p:2..p:4 queue behind it and p:2 is dropped.
  relay.handleStatus(status('done', 'done', 1, 'p:2'))
  relay.handleStatus(status('done', 'done', 1, 'p:3'))
  relay.handleStatus(status('done', 'done', 1, 'p:4'))
  assert.deepEqual(logs, ['dropped kind=done: more than 2 deliveries pending'])

  for (let i = 0; i < 3; i += 1) {
    while (releases.length <= i) await tick()
    releases[i]()
  }
  await relay.idle()
  assert.equal(calls.length, 3)
})

test('re-reads the config for every event', async () => {
  const configPath = await configFile({ url: 'https://first.example', secret: SECRET })
  const { calls, fetchImpl } = recordingFetch()
  const relay = createRelay({ configPath, fetchImpl, log: () => {} })
  relay.handleStatus(status('done', 'done', 1))
  await relay.idle()
  await writeConfig(configPath, { url: 'https://second.example', secret: SECRET })
  relay.handleStatus(status('waiting', 'waiting', 2))
  await relay.idle()
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://first.example/', 'https://second.example/']
  )
})

test('honours the configured states', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET, states: ['working'] })
  const { calls, fetchImpl } = recordingFetch()
  const relay = createRelay({ configPath, fetchImpl, log: () => {} })
  relay.handleStatus(status('working', 'working', 1))
  relay.handleStatus(status('working', 'done', 2))
  await relay.idle()
  assert.deepEqual(
    calls.map((c) => c.body.kind),
    ['working']
  )
})

test('logs config problems, sends nothing, and keeps going', async () => {
  const { calls, fetchImpl } = recordingFetch()
  const logs = []
  const relay = createRelay({ configPath: '/nonexistent/config.json', fetchImpl, log: (l) => logs.push(l) })
  relay.handleStatus(status('done', 'done', 1))
  relay.handleStatus(status('waiting', 'waiting', 2))
  await relay.idle()
  assert.equal(calls.length, 0)
  assert.equal(logs.length, 2)
  assert.match(logs[0], /^config error \(missing\)/)
})

test('an unexpected fetch error does not stop later deliveries', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET })
  let first = true
  const delivered = []
  const fetchImpl = async (_url, init) => {
    if (first) {
      first = false
      throw new RangeError('boom')
    }
    delivered.push(JSON.parse(init.body).kind)
    return new Response(null, { status: 204 })
  }
  const logs = []
  const relay = createRelay({ configPath, fetchImpl, log: (l) => logs.push(l) })
  relay.handleStatus(status('done', 'done', 1))
  relay.handleStatus(status('waiting', 'waiting', 2))
  await relay.idle()
  assert.deepEqual(delivered, ['waiting'])
  assert.equal(logs[0], 'failed kind=done reason=network (RangeError)')
})

test('logs a failed delivery without the url', async () => {
  const configPath = await configFile({ url: 'https://private-host.example/hook', secret: SECRET })
  const logs = []
  const relay = createRelay({ configPath, fetchImpl: recordingFetch(500).fetchImpl, log: (l) => logs.push(l) })
  relay.handleStatus(status('done', 'done', 1))
  await relay.idle()
  assert.deepEqual(logs, ['failed kind=done reason=http_status status=500'])
})

test('sendTest answers without waiting for queued deliveries', async () => {
  const configPath = await configFile({ url: 'https://example.com', secret: SECRET })
  const held = heldFetch()
  const posted = []
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body)
    if (body.type === 'relay.test') {
      posted.push(body)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return held.fetchImpl(url, init)
  }
  const relay = createRelay({ configPath, fetchImpl, log: () => {}, now: () => 42_000 })
  relay.handleStatus(status('done', 'done', 1))
  while (held.calls.length < 1) await tick()

  assert.deepEqual(await relay.sendTest(), { ok: true, status: 204 })
  assert.deepEqual(posted, [{ type: 'relay.test', sentAt: 42_000 }])
  held.releases[0]()
  await relay.idle()
})

test('activate registers handlers that return immediately', async () => {
  const handlers = {}
  const commands = {}
  activate({
    events: { on: (name, handler) => (handlers[name] = handler) },
    commands: { register: (id, handler) => (commands[id] = handler) },
    log: () => {}
  })
  assert.deepEqual(Object.keys(handlers), ['agent.status.changed'])
  assert.deepEqual(Object.keys(commands), ['agent-status-relay.send-test'])
  // Orca acks the event once the handler settles, so it must not return a pending delivery.
  assert.equal(handlers['agent.status.changed'](status('done', 'done', 1)), undefined)
})
