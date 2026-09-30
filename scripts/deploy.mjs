import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { createHmac } from 'node:crypto'
import { resolveCname } from 'node:dns/promises'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { root, loadEnv, application } from './env.mjs'
export async function validateRepository(values, transport = fetch) {
  const repository = values.REDIRECTORY_GITHUB_REPOSITORY
  if (!repository) return
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository || ''))
    throw new Error('Set REDIRECTORY_GITHUB_REPOSITORY')
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'redirectory',
  }
  if (values.REDIRECTORY_GITHUB_READ_TOKEN)
    headers.Authorization = `Bearer ${values.REDIRECTORY_GITHUB_READ_TOKEN}`
  const get = async (path) => {
    try {
      return await transport(
        `https://api.github.com/repos/${repository}${path}`,
        {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      )
    } catch {
      throw new Error(
        'Could not verify the GitHub package repository. Check your connection',
      )
    }
  }
  const response = await get('')
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Package repository verification failed (HTTP ${response.status}). Check the repository and read token`,
    )
  }
  let metadata
  try {
    metadata = await response.json()
  } catch {
    throw new Error('Invalid GitHub repository response')
  }
  if (metadata.private !== false)
    throw new Error('The package repository must be public')
  if (typeof metadata.default_branch !== 'string' || !metadata.default_branch)
    throw new Error(
      'The package repository needs an initialized default branch',
    )
  const branch = await get(
    `/branches/${encodeURIComponent(metadata.default_branch)}`,
  )
  await branch.body?.cancel()
  if ([404, 409].includes(branch.status))
    throw new Error(
      'The package repository needs an initial commit on its default branch before deployment',
    )
  if (!branch.ok)
    throw new Error(
      `Could not verify the package repository default branch (HTTP ${branch.status})`,
    )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const work = resolve(root, '.deploy')

export function deployment(values) {
  const create = values.REDIRECTORY_CREATE_PROJECT || 'false'
  if (!['true', 'false'].includes(create))
    throw new Error('Invalid REDIRECTORY_CREATE_PROJECT')
  const project = values.SCW_DEFAULT_PROJECT_ID || ''
  const organization = values.SCW_DEFAULT_ORGANIZATION_ID || ''
  const uuid = /^[0-9a-fA-F-]{36}$/
  if (
    create === 'true'
      ? project || !uuid.test(organization)
      : !uuid.test(project)
  )
    throw new Error(
      'Choose an existing project ID or enable project creation with an organization ID',
    )
  if (!values.SCW_ACCESS_KEY || !values.SCW_SECRET_KEY)
    throw new Error('Set the Scaleway API credentials')
  if (
    !/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(
      values.REDIRECTORY_IMAGE || '',
    )
  )
    throw new Error('Set REDIRECTORY_IMAGE to a public image digest')
  const region = values.SCW_DEFAULT_REGION || 'pl-waw'
  if (!['pl-waw', 'fr-par', 'nl-ams'].includes(region))
    throw new Error('Unsupported Scaleway region')
  for (const key of ['REDIRECTORY_PROJECT_NAME', 'REDIRECTORY_CONTAINER_NAME'])
    if (values[key] && !/^[a-z][a-z0-9-]{0,49}$/.test(values[key]))
      throw new Error(`Invalid ${key}`)
  const hostname = values.REDIRECTORY_DOMAIN || ''
  const zone = values.REDIRECTORY_DNS_ZONE || ''
  for (const domain of [hostname, zone])
    if (
      domain &&
      (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) ||
        domain.length > 253)
    )
      throw new Error('Invalid domain configuration')
  if (zone && (!hostname || !hostname.endsWith('.' + zone)))
    throw new Error('The hostname must be a subdomain of REDIRECTORY_DNS_ZONE')
  const integer = (key, fallback, min, max) => {
    const value = Number(values[key] || fallback)
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`)
    return value
  }
  const vars = {
    region,
    project_id: project,
    organization_id: organization,
    create_project: create === 'true',
    project_name: values.REDIRECTORY_PROJECT_NAME || 'redirectory',
    container_name: values.REDIRECTORY_CONTAINER_NAME || 'redirectory',
    image: values.REDIRECTORY_IMAGE,
    port: integer('PORT', 9595, 1, 65535),
    cpu_limit: integer('REDIRECTORY_CPU_LIMIT', 140, 70, 4000),
    memory_limit: integer('REDIRECTORY_MEMORY_LIMIT', 256, 128, 8192),
    min_scale: integer('REDIRECTORY_MIN_SCALE', 0, 0, 20),
    max_scale: integer('REDIRECTORY_MAX_SCALE', 1, 1, 20),
    application_environment: application(values),
  }
  if (vars.min_scale > vars.max_scale)
    throw new Error('Minimum scale exceeds maximum scale')
  return { vars, hostname, zone }
}

function runner(values) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      key.startsWith('TF_') ||
      key.startsWith('TOFU_') ||
      key.startsWith('REDIRECTORY_') ||
      key.startsWith('SCW_')
    )
      delete env[key]
  env.SCW_ACCESS_KEY = values.SCW_ACCESS_KEY
  env.SCW_SECRET_KEY = values.SCW_SECRET_KEY
  env.TF_IN_AUTOMATION = 'true'
  return (directory, args, capture = false, vars = undefined) => {
    const tfEnv = { ...env }
    if (vars)
      for (const [key, value] of Object.entries(vars))
        tfEnv[`TF_VAR_${key}`] =
          typeof value === 'object' ? JSON.stringify(value) : String(value)
    const result = spawnSync('tofu', [`-chdir=${directory}`, ...args], {
      cwd: root,
      env: tfEnv,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
      windowsHide: true,
    })
    if (result.error || result.status !== 0)
      throw new Error('OpenTofu failed. Check the plan and installed tools')
    return result.stdout
  }
}

async function waitFor(check, description, seconds = 600) {
  const deadline = Date.now() + seconds * 1000
  let delay = 1000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
    delay = Math.min(delay * 1.5, 10000)
  }
  throw new Error(
    `Timed out waiting for ${description}. Correct the configuration and run deploy again.`,
  )
}

async function api(values, id, body) {
  const [region, uuid] = id.split('/')
  if (
    !['fr-par', 'pl-waw', 'nl-ams'].includes(region) ||
    !/^[0-9a-f-]{36}$/.test(uuid)
  )
    throw new Error('Invalid container identifier')
  const response = await fetch(
    `https://api.scaleway.com/containers/v1/regions/${region}/containers/${uuid}`,
    {
      method: body ? 'PATCH' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        'X-Auth-Token': values.SCW_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  )
  if (!response.ok)
    throw new Error(`Scaleway container API failed (HTTP ${response.status})`)
  return response.json()
}

export function activation(values, id, current, previous = {}) {
  const secrets = {
    REDIRECTORY_ENCRYPTION_KEY: values.REDIRECTORY_ENCRYPTION_KEY,
    REDIRECTORY_GITHUB_READ_TOKEN: values.REDIRECTORY_GITHUB_READ_TOKEN || '',
    REDIRECTORY_PUBLIC_URL:
      values.REDIRECTORY_PUBLIC_URL ||
      (values.REDIRECTORY_DOMAIN
        ? 'https://' + values.REDIRECTORY_DOMAIN
        : current.domain_name
          ? 'https://' + current.domain_name
          : ''),
  }
  const signature = createHmac(
    'sha256',
    Buffer.from(values.REDIRECTORY_ENCRYPTION_KEY, 'hex'),
  )
    .update(JSON.stringify({ id, secrets }))
    .digest('hex')
  const command = ['node', 'dist/serve.js']
  const ordered = (object) =>
    JSON.stringify(
      Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)),
    )
  if (
    previous.signature === signature &&
    JSON.stringify(current.command) === JSON.stringify(command) &&
    ordered(previous.hashes) === ordered(current.secret_environment_variables)
  )
    return { signature }
  return { signature, body: { command, secret_environment_variables: secrets } }
}

async function activate(values, id) {
  const path = resolve(work, 'activation.json')
  const previous = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {}
  const current = await api(values, id)
  const { signature, body } = activation(values, id, current, previous)
  if (!body) return
  const updated = await api(values, id, body)
  const hashes = updated.secret_environment_variables || {}
  if (
    Object.values(hashes).some((value) =>
      Object.values(body.secret_environment_variables)
        .filter(Boolean)
        .includes(value),
    )
  )
    throw new Error(
      'The platform returned plaintext secrets. Activation state was not saved',
    )
  writeFileSync(path, JSON.stringify({ signature, hashes }), { mode: 0o600 })
}

export async function main(args = process.argv.slice(2)) {
  if (
    args.some((arg) => !['--plan', '--destroy', '--yes'].includes(arg)) ||
    (args.includes('--plan') && args.includes('--destroy'))
  )
    throw new Error('Usage: deploy [--plan] or destroy [--yes]')
  const destroy = args.includes('--destroy')
  const values = loadEnv(!destroy && !args.includes('--plan'))
  const config = deployment(values)
  if (!destroy) await validateRepository(values)
  mkdirSync(work, { recursive: true, mode: 0o700 })
  const run = runner(values)
  const core = resolve(root, 'infra/scaleway')
  const domain = resolve(core, 'domain')
  const domainState = resolve(work, 'domain.tfstate')
  const state = resolve(work, 'core.tfstate')
  const domainVarsPath = resolve(work, 'domain.json')
  const savedVars = resolve(work, 'core.json')
  if (existsSync(savedVars)) {
    const saved = JSON.parse(readFileSync(savedVars, 'utf8'))
    for (const key of [
      'region',
      'project_id',
      'organization_id',
      'create_project',
      'project_name',
      'container_name',
    ])
      if (saved[key] !== config.vars[key])
        throw new Error(
          'Deployment identity changed. Restore the previous settings or use a separate checkout and state for a new deployment.',
        )
  }
  const apply = (directory, vars, stateFile, deleting = false) => {
    run(directory, [
      'init',
      '-input=false',
      '-reconfigure',
      `-backend-config=path=${stateFile}`,
    ])
    const plan = resolve(work, deleting ? 'destroy.tfplan' : 'deploy.tfplan')
    try {
      run(
        directory,
        [
          'plan',
          '-input=false',
          `-out=${plan}`,
          ...(deleting ? ['-destroy'] : []),
        ],
        false,
        vars,
      )
      if (!args.includes('--plan'))
        run(directory, ['apply', '-input=false', plan], false, vars)
    } finally {
      if (existsSync(plan)) rmSync(plan)
    }
  }
  if (destroy) {
    if (!existsSync(state) && !existsSync(domainState))
      throw new Error('No deployment state found')
    if (!args.includes('--yes')) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      const answer = await prompt.question(
        'Delete the resources owned by this deployment? Type destroy: ',
      )
      prompt.close()
      if (answer !== 'destroy') throw new Error('Cancelled')
    }
    if (existsSync(domainVarsPath))
      apply(
        domain,
        JSON.parse(readFileSync(domainVarsPath, 'utf8')),
        domainState,
        true,
      )
    if (existsSync(state)) apply(core, config.vars, state, true)
    for (const path of [
      savedVars,
      domainVarsPath,
      resolve(work, 'activation.json'),
      state,
      domainState,
    ])
      if (existsSync(path)) rmSync(path)
    console.log(
      'Deployment resources removed. Package releases and external DNS records were not deleted.',
    )
    return
  }
  if (!args.includes('--plan'))
    writeFileSync(savedVars, JSON.stringify(config.vars, null, 2))
  apply(core, config.vars, state)
  if (args.includes('--plan')) {
    console.log(
      'This plans the container first. The domain comes after its endpoint is ready.',
    )
    return
  }
  const outputs = JSON.parse(run(core, ['output', '-json'], true))
  const endpoint = outputs.endpoint.value
  const id = outputs.container_id.value
  if (new URL(endpoint).protocol !== 'https:')
    throw new Error('Expected an HTTPS platform endpoint')
  await activate(values, id)
  const healthy = async (target) => {
    try {
      const response = await fetch(target + '/healthz', {
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      })
      return response.ok && (await response.json()).status === 'ok'
    } catch {
      return false
    }
  }
  console.log(`Waiting for ${endpoint}`)
  await waitFor(() => healthy(endpoint), 'container health')
  if (config.hostname) {
    const vars = {
      region: config.vars.region,
      container_id: id,
      endpoint,
      hostname: config.hostname,
      dns_zone: config.zone,
    }
    if (!config.zone) {
      const target = new URL(endpoint).hostname
      console.log(
        `Add DNS CNAME ${config.hostname} -> ${target} (DNS only, proxy disabled). Waiting for DNS.`,
      )
      await waitFor(async () => {
        try {
          return (await resolveCname(config.hostname)).some(
            (value) => value.replace(/\.$/, '').toLowerCase() === target,
          )
        } catch {
          return false
        }
      }, 'the CNAME record')
    }
    writeFileSync(domainVarsPath, JSON.stringify(vars))
    apply(domain, vars, domainState)
    await waitFor(
      () => healthy('https://' + config.hostname),
      'custom domain HTTPS',
      900,
    )
  } else if (existsSync(domainVarsPath)) {
    apply(
      domain,
      JSON.parse(readFileSync(domainVarsPath, 'utf8')),
      domainState,
      true,
    )
    rmSync(domainVarsPath)
  }
  const target = config.hostname ? 'https://' + config.hostname : endpoint
  console.log(
    `Ready: ${target}\nconan remote add redirectory ${target}\nconan remote login redirectory YOUR_GITHUB_USERNAME`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof TypeError
        ? 'Deployment failed. Check your connection and configuration'
        : error.message,
    )
    process.exitCode = 1
  })
