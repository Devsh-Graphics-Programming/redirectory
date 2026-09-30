import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Config } from './config.js'
import type { Request } from 'express'
import { Error as HttpError } from './http.js'

export interface Credentials {
  user: string
  token: string
}

export function basic(header?: string): Credentials {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header || '')
  if (!match) throw new HttpError(401, 'Authentication required')
  const text = Buffer.from(match[1], 'base64').toString('utf8')
  const split = text.indexOf(':')
  if (split < 1 || split === text.length - 1 || /[\x00-\x1f\x7f]/.test(text))
    throw new HttpError(401, 'Invalid credentials')
  return { user: text.slice(0, split), token: text.slice(split + 1) }
}

const lifetime = 30 * 60 * 1000
type Payload = Credentials & {
  exp: number
  path?: string
  size?: number
  method?: string
}

function seal(
  config: Config,
  value: Omit<Payload, 'exp'>,
  purpose: string,
  now: number,
) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', config.key, iv)
  cipher.setAAD(Buffer.from(purpose))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ ...value, exp: now + lifetime })),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    'base64url',
  )
}

function open(
  config: Config,
  text: unknown,
  purpose: string,
  now: number,
): Payload {
  try {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{40,8192}$/.test(text))
      throw new Error()
    const bytes = Buffer.from(text, 'base64url')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      config.key,
      bytes.subarray(0, 12),
    )
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const value = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    )
    if (
      typeof value.user !== 'string' ||
      typeof value.token !== 'string' ||
      !value.token ||
      !Number.isSafeInteger(value.exp) ||
      value.exp <= now ||
      value.exp > now + lifetime
    )
      throw new Error()
    return value
  } catch {
    throw new HttpError(401, 'Invalid or expired token. Log in again')
  }
}

export function issue(
  config: Config,
  credentials: Credentials,
  now = Date.now(),
) {
  return seal(
    config,
    credentials,
    'redirectory-session-v1:' + config.repository,
    now,
  )
}

export function bearer(
  config: Config,
  header?: string,
  now = Date.now(),
): Credentials {
  const { user, token } = open(
    config,
    /^Bearer (.+)$/i.exec(header || '')?.[1],
    'redirectory-session-v1:' + config.repository,
    now,
  )
  return { user, token }
}

export function grant(
  config: Config,
  credentials: Credentials,
  path: string,
  size: number,
  now = Date.now(),
) {
  return seal(
    config,
    { ...credentials, path, size, method: 'PUT' },
    'redirectory-upload-v1',
    now,
  )
}

export function checkGrant(
  config: Config,
  req: Request,
  now = Date.now(),
): Credentials {
  const value = open(config, req.query.signature, 'redirectory-upload-v1', now)
  if (
    value.method !== req.method ||
    value.path !== req.path ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > config.maxUploadBytes ||
    String(value.size) !== req.get('Content-Length')
  )
    throw new HttpError(401, 'Invalid upload grant')
  return { user: value.user, token: value.token }
}
