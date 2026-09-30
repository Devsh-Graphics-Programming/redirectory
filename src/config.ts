export interface Config {
  repository: string
  key: Buffer
  readToken?: string
  anonymousRead: boolean
  port: number
  maxUploadBytes: number
  requestTimeoutMs: number
  publicUrl?: string
}

export function configuration(env = process.env): Config {
  const repository = env.REDIRECTORY_GITHUB_REPOSITORY || ''
  if (
    repository &&
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    throw new Error('Set REDIRECTORY_GITHUB_REPOSITORY to owner/repository')
  const key = env.REDIRECTORY_ENCRYPTION_KEY || ''
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new Error(
      'REDIRECTORY_ENCRYPTION_KEY must contain 64 hexadecimal characters',
    )
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] || fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}`)
    return value
  }
  const anonymous = env.REDIRECTORY_ANONYMOUS_READ || 'true'
  const publicUrl = env.REDIRECTORY_PUBLIC_URL || undefined
  if (publicUrl) {
    const url = new URL(publicUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid REDIRECTORY_PUBLIC_URL')
  }
  if (!['true', 'false'].includes(anonymous))
    throw new Error('Invalid REDIRECTORY_ANONYMOUS_READ')
  return {
    repository,
    publicUrl,
    key: Buffer.from(key, 'hex'),
    readToken: env.REDIRECTORY_GITHUB_READ_TOKEN || undefined,
    anonymousRead: anonymous === 'true',
    port: integer('PORT', 9595, 65535),
    maxUploadBytes: integer(
      'REDIRECTORY_MAX_UPLOAD_BYTES',
      1073741824,
      2147483647,
    ),
    requestTimeoutMs:
      integer('REDIRECTORY_REQUEST_TIMEOUT_SECONDS', 300, 900) * 1000,
  }
}
