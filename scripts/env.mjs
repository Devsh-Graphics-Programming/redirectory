import { configuration } from '../src/config.ts'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const documented = new Set(
  readFileSync(resolve(root, '.env.example'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.split('=')[0]),
)

export function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || !documented.has(match[1]))
      throw new Error('The environment file contains an undocumented setting')
    if (Object.hasOwn(result, match[1]))
      throw new Error(`Duplicate setting: ${match[1]}`)
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    if (/[\r\n\x00]/.test(value) || value.includes('$'))
      throw new Error(
        `Unsupported characters in ${match[1]}. Use plain values without interpolation`,
      )
    result[match[1]] = value
  }
  return result
}

export function loadEnv(generateKey = false) {
  const path = resolve(root, '.env')
  if (!existsSync(path))
    throw new Error('Copy .env.example to .env before configuring the server')
  let text = readFileSync(path, 'utf8')
  const values = parseEnv(text)
  for (const key of documented)
    if (process.env[key] !== undefined) values[key] = process.env[key]
  if (!values.REDIRECTORY_ENCRYPTION_KEY && generateKey) {
    values.REDIRECTORY_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    const line = `REDIRECTORY_ENCRYPTION_KEY=${values.REDIRECTORY_ENCRYPTION_KEY}`
    text = /^REDIRECTORY_ENCRYPTION_KEY=.*$/m.test(text)
      ? text.replace(/^REDIRECTORY_ENCRYPTION_KEY=.*$/m, line)
      : text + '\n' + line + '\n'
    writeFileSync(path, text, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }
  return values
}

export function application(values) {
  const config = configuration(values)
  const hostPort = Number(values.HOST_PORT || 9595)
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)
    throw new Error('Invalid HOST_PORT')
  return {
    ...(config.repository
      ? { REDIRECTORY_GITHUB_REPOSITORY: config.repository }
      : {}),
    REDIRECTORY_ANONYMOUS_READ: String(config.anonymousRead),
    REDIRECTORY_MAX_UPLOAD_BYTES: String(config.maxUploadBytes),
    REDIRECTORY_REQUEST_TIMEOUT_SECONDS: String(config.requestTimeoutMs / 1000),
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    application(loadEnv(true))
    console.log(
      'Configuration ready. Keep .env private and back up the encryption key.',
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
