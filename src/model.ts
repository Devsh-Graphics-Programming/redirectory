import { createHash } from 'node:crypto'
import { Error as HttpError } from './http.js'

export interface Reference {
  name: string
  version: string
  user: string
  channel: string
  rrev?: string
  package?: string
  prev?: string
}

export const fields = [
  'name',
  'version',
  'user',
  'channel',
  'rrev',
  'package',
  'prev',
] as const

export function reference(params: Record<string, unknown>): Reference {
  const result: Record<string, string> = {}
  for (const field of fields) {
    const value = params[field]
    if (value === undefined && ['rrev', 'package', 'prev'].includes(field))
      continue
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,100}$/.test(value)
    )
      throw new HttpError(400, 'Invalid package reference')
    result[field] = value
  }
  return result as unknown as Reference
}

export function tag(ref: Reference): string {
  return (
    'rd-v1-' +
    createHash('sha256')
      .update(JSON.stringify(fields.map((key) => ref[key] || null)))
      .digest('hex')
  )
}

export function display(ref: Reference): string {
  return (
    `${ref.name}/${ref.version}` +
    (ref.user === '_' && ref.channel === '_'
      ? ''
      : `@${ref.user}/${ref.channel}`)
  )
}

export function filename(value: unknown): string {
  const text = Array.isArray(value) ? value.join('/') : value
  if (
    typeof text !== 'string' ||
    text.length > 160 ||
    !text.split('/').every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))
  )
    throw new HttpError(400, 'Invalid filename')
  return text
}

export function assetName(name: string): string {
  return 'f-' + Buffer.from(filename(name)).toString('base64url')
}

export function originalName(name: string): string | undefined {
  if (!name.startsWith('f-')) return undefined
  try {
    const result = filename(Buffer.from(name.slice(2), 'base64url').toString())
    return assetName(result) === name ? result : undefined
  } catch {
    return undefined
  }
}

export function matches(ref: Reference, prefix: Reference): boolean {
  return fields.every(
    (key) => prefix[key] === undefined || prefix[key] === ref[key],
  )
}
