import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigError, DEFAULT_STATES, loadConfig, parseConfig } from '../src/config.mjs'

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

async function writeConfig(value, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-config-'))
  const path = join(dir, 'config.json')
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  await chmod(path, mode)
  return path
}

function assertConfigError(fn, code, pattern) {
  return assert.rejects(fn, (error) => {
    assert.ok(error instanceof ConfigError)
    assert.equal(error.code, code)
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

test('loads a valid config and defaults states', async () => {
  const path = await writeConfig({ url: 'https://example.com/hook', secret: SECRET })
  const config = await loadConfig(path)
  assert.equal(config.url.href, 'https://example.com/hook')
  assert.equal(config.secret.length, 32)
  assert.deepEqual(config.states, DEFAULT_STATES)
})

test('reports a missing file', async () => {
  await assertConfigError(() => loadConfig('/nonexistent/relay/config.json'), 'missing')
})

test('refuses Windows instead of failing the permission check', async () => {
  const path = await writeConfig({ url: 'https://example.com', secret: SECRET })
  await assertConfigError(() => loadConfig(path, 'win32'), 'unsupported_platform')
})

test('refuses a config any group or other bit allows', async () => {
  for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
    const path = await writeConfig({ url: 'https://example.com', secret: SECRET }, mode)
    await assertConfigError(() => loadConfig(path), 'insecure_permissions', /chmod 600/)
  }
})

test('accepts owner-only modes', async () => {
  for (const mode of [0o600, 0o400, 0o700]) {
    const path = await writeConfig({ url: 'https://example.com', secret: SECRET }, mode)
    assert.equal((await loadConfig(path)).url.hostname, 'example.com')
  }
})

test('reports a directory as unreadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-config-dir-'))
  await chmod(dir, 0o700)
  await assertConfigError(() => loadConfig(dir), 'unreadable')
})

test('reports invalid JSON', async () => {
  const path = await writeConfig('{not json')
  await assertConfigError(() => loadConfig(path), 'invalid_json')
})

test('allows plain http only for loopback hosts', () => {
  for (const url of ['http://127.0.0.1:47821/e', 'http://localhost/e', 'http://LOCALHOST/e', 'http://[::1]:8080/e']) {
    assert.equal(parseConfig({ url, secret: SECRET }).url.href, new URL(url).href)
  }
  for (const url of [
    'http://example.com/e',
    'http://localhost./e',
    'http://127.0.0.2/e',
    'http://[::ffff:127.0.0.1]/e',
    'ftp://example.com/e'
  ]) {
    assert.throws(() => parseConfig({ url, secret: SECRET }), /must use https/, url)
  }
})

test('rejects credentials in the url', () => {
  assert.throws(
    () => parseConfig({ url: 'https://user:pass@example.com/e', secret: SECRET }),
    /must not contain credentials/
  )
})

test('rejects malformed secrets', () => {
  const url = 'https://example.com'
  assert.throws(() => parseConfig({ url, secret: 'plain' }), /whsec_/)
  assert.throws(() => parseConfig({ url, secret: 'whsec_!!!' }), /base64/)
  assert.throws(() => parseConfig({ url, secret: `whsec_${Buffer.alloc(8).toString('base64')}` }), /24-64 bytes/)
  assert.throws(() => parseConfig({ url, secret: `whsec_${Buffer.alloc(65).toString('base64')}` }), /24-64 bytes/)
})

test('validates states', () => {
  const base = { url: 'https://example.com', secret: SECRET }
  assert.deepEqual(parseConfig({ ...base, states: ['done'] }).states, ['done'])
  assert.throws(() => parseConfig({ ...base, states: [] }), /non-empty/)
  assert.throws(() => parseConfig({ ...base, states: ['finished'] }), /unknown state/)
  assert.throws(() => parseConfig({ ...base, states: ['done', 'done'] }), /duplicates/)
})

test('rejects unknown keys', () => {
  assert.throws(
    () => parseConfig({ url: 'https://example.com', secret: SECRET, retries: 3 }),
    /unknown config key: retries/
  )
})

test('error messages never contain the url host or the secret', () => {
  const shortSecret = `whsec_${Buffer.alloc(8, 1).toString('base64')}`
  const cases = [
    { url: 'http://secret-host.example/x', secret: SECRET },
    { url: 'https://user:pw@secret-host.example/x', secret: SECRET },
    { url: 'https://example.com', secret: shortSecret },
    { url: 'https://example.com', secret: 'whsec_!!!' }
  ]
  for (const value of cases) {
    try {
      parseConfig(value)
      assert.fail('expected an error')
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      assert.doesNotMatch(error.message, /secret-host|user:pw/)
      assert.ok(!error.message.includes(value.secret), 'secret leaked into the message')
      assert.ok(!error.message.includes(value.secret.slice(6)), 'secret body leaked into the message')
    }
  }
})

test('rejects a FIFO without blocking', async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'relay-config-fifo-'))
  const path = join(dir, 'config.json')
  execFileSync('mkfifo', ['-m', '600', path])
  await assertConfigError(() => loadConfig(path), 'unreadable', /not a regular file/)
})
