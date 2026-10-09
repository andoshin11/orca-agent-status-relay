import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done']
export const DEFAULT_STATES = ['done', 'waiting', 'blocked']

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
const ALLOWED_KEYS = new Set(['url', 'secret', 'states'])
// Standard Webhooks secrets are 24–64 random bytes.
const SECRET_MIN_BYTES = 24
const SECRET_MAX_BYTES = 64

export class ConfigError extends Error {
  /**
   * @param {'unsupported_platform' | 'missing' | 'unreadable' | 'insecure_permissions' | 'invalid_json' | 'invalid'} code
   * @param {string} message Never includes the URL or the secret.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

export function defaultConfigPath() {
  return join(homedir(), '.config', 'orca-agent-status-relay', 'config.json')
}

/**
 * Reads and validates the relay config. Throws ConfigError on any problem;
 * there are no defaults for `url` or `secret`.
 *
 * @param {string} path
 * @param {NodeJS.Platform} [platform]
 * @returns {Promise<{ url: URL, secret: Uint8Array, states: string[] }>}
 */
export async function loadConfig(path, platform = process.platform) {
  // Why: the permission check below relies on POSIX modes; on Windows every
  // file reports 0o666, so the check could never pass.
  if (platform === 'win32') {
    throw new ConfigError('unsupported_platform', 'Windows is not supported yet (macOS and Linux only)')
  }

  let handle
  try {
    // O_NONBLOCK: a FIFO at the config path would otherwise block forever here,
    // before the isFile check can reject it.
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ConfigError('missing', `config file not found: ${path}`)
    }
    throw new ConfigError('unreadable', `cannot open config file (${error?.code ?? 'unknown'})`)
  }

  let raw
  try {
    // Checked on the opened descriptor, so the file cannot be swapped between
    // the check and the read.
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new ConfigError('unreadable', 'config path is not a regular file')
    }
    if (info.uid !== process.getuid()) {
      throw new ConfigError('insecure_permissions', 'config file must be owned by the current user')
    }
    // Why: the file holds the signing secret, so group/other access is refused
    // rather than silently tolerated.
    if ((info.mode & 0o077) !== 0) {
      throw new ConfigError(
        'insecure_permissions',
        `config file must not be accessible by group or others (run: chmod 600 ${path})`
      )
    }
    raw = await handle.readFile('utf8')
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error
    }
    throw new ConfigError('unreadable', `cannot read config file (${error?.code ?? 'unknown'})`)
  } finally {
    // A close failure must not mask the ConfigError being thrown.
    await handle.close().catch(() => undefined)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigError('invalid_json', 'config file is not valid JSON')
  }
  return parseConfig(parsed)
}

/** @param {unknown} value */
export function parseConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('invalid', 'config must be a JSON object')
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError('invalid', `unknown config key: ${key}`)
    }
  }
  return {
    url: parseUrl(value.url),
    secret: parseSecret(value.secret),
    states: parseStates(value.states)
  }
}

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('invalid', 'url is required')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError('invalid', 'url is not a valid URL')
  }
  if (url.username || url.password) {
    throw new ConfigError('invalid', 'url must not contain credentials')
  }
  if (url.protocol === 'https:') {
    return url
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return url
  }
  throw new ConfigError('invalid', 'url must use https (plain http is allowed only for loopback hosts)')
}

function parseSecret(value) {
  if (typeof value !== 'string' || !value.startsWith('whsec_')) {
    throw new ConfigError('invalid', 'secret must be a Standard Webhooks secret starting with "whsec_"')
  }
  const encoded = value.slice('whsec_'.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ConfigError('invalid', 'secret is not valid base64 after "whsec_"')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < SECRET_MIN_BYTES || bytes.length > SECRET_MAX_BYTES) {
    throw new ConfigError(
      'invalid',
      `secret must decode to ${SECRET_MIN_BYTES}-${SECRET_MAX_BYTES} bytes`
    )
  }
  return new Uint8Array(bytes)
}

function parseStates(value) {
  if (value === undefined) {
    return [...DEFAULT_STATES]
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError('invalid', 'states must be a non-empty array')
  }
  for (const state of value) {
    if (!AGENT_STATES.includes(state)) {
      throw new ConfigError('invalid', `unknown state in states: ${String(state)}`)
    }
  }
  if (new Set(value).size !== value.length) {
    throw new ConfigError('invalid', 'states must not contain duplicates')
  }
  return [...value]
}
