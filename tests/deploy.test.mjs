import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEnv, application } from '../scripts/env.mjs'
import {
  deployment,
  activation,
  validateRepository,
} from '../scripts/deploy.mjs'

const values = {
  REDIRECTORY_GITHUB_REPOSITORY: 'test/packages',
  REDIRECTORY_ENCRYPTION_KEY: 'ab'.repeat(32),
  REDIRECTORY_GITHUB_READ_TOKEN: 'private-read-token',
  SCW_ACCESS_KEY: 'private-access',
  SCW_SECRET_KEY: 'private-secret',
  SCW_DEFAULT_PROJECT_ID: '00000000-0000-4000-8000-000000000001',
  REDIRECTORY_IMAGE: 'ghcr.io/example/redirectory@sha256:' + 'a'.repeat(64),
}

test('activation is idempotent and detects key rotation and platform drift', () => {
  const id = 'pl-waw/00000000-0000-4000-8000-000000000001'
  const first = activation(values, id, { command: ['bootstrap'] })
  assert.equal(
    activation(values, id, { domain_name: 'example.scw.cloud' }).body
      .secret_environment_variables.REDIRECTORY_PUBLIC_URL,
    'https://example.scw.cloud',
  )
  assert.equal(
    activation({ ...values, REDIRECTORY_DOMAIN: 'conan.example.com' }, id, {
      domain_name: 'example.scw.cloud',
    }).body.secret_environment_variables.REDIRECTORY_PUBLIC_URL,
    'https://conan.example.com',
  )
  assert.equal(
    first.body.secret_environment_variables.REDIRECTORY_ENCRYPTION_KEY,
    values.REDIRECTORY_ENCRYPTION_KEY,
  )
  const current = {
    command: first.body.command,
    secret_environment_variables: { b: 'hash-b', a: 'hash-a' },
  }
  const previous = {
    signature: first.signature,
    hashes: { a: 'hash-a', b: 'hash-b' },
  }
  assert.equal(activation(values, id, current, previous).body, undefined)
  assert.ok(
    activation(
      { ...values, REDIRECTORY_ENCRYPTION_KEY: 'cd'.repeat(32) },
      id,
      current,
      previous,
    ).body,
  )
  assert.ok(
    activation(
      values,
      id,
      { ...current, secret_environment_variables: {} },
      previous,
    ).body,
  )
  assert.ok(
    activation(values, id, { ...current, command: ['bootstrap'] }, previous)
      .body,
  )
  assert.ok(
    !JSON.stringify(previous).includes(values.REDIRECTORY_GITHUB_READ_TOKEN),
  )
})

test('environment parsing does not execute or interpolate input', () => {
  assert.equal(
    parseEnv('REDIRECTORY_DOMAIN="conan.example.com"').REDIRECTORY_DOMAIN,
    'conan.example.com',
  )
  assert.throws(() => parseEnv('UNKNOWN=foo'))
  assert.throws(() => parseEnv('REDIRECTORY_DOMAIN=$(whoami)'))
  assert.throws(() => parseEnv('PORT=1\nPORT=2'))
})

test('deployment validates identity and keeps secrets out of Terraform variables', () => {
  const output = deployment(values)
  assert.equal(output.vars.project_id, values.SCW_DEFAULT_PROJECT_ID)
  assert.equal(output.vars.create_project, false)
  for (const secret of [
    values.SCW_SECRET_KEY,
    values.SCW_ACCESS_KEY,
    values.REDIRECTORY_ENCRYPTION_KEY,
    values.REDIRECTORY_GITHUB_READ_TOKEN,
  ])
    assert.ok(!JSON.stringify(output).includes(secret))
  assert.throws(() =>
    deployment({ ...values, REDIRECTORY_CREATE_PROJECT: 'true' }),
  )
  assert.throws(() =>
    deployment({ ...values, REDIRECTORY_IMAGE: 'example:latest' }),
  )
  assert.throws(() =>
    deployment({
      ...values,
      REDIRECTORY_DOMAIN: 'other.example.com',
      REDIRECTORY_DNS_ZONE: 'wrong.com',
    }),
  )
  const created = deployment({
    ...values,
    SCW_DEFAULT_PROJECT_ID: '',
    SCW_DEFAULT_ORGANIZATION_ID: values.SCW_DEFAULT_PROJECT_ID,
    REDIRECTORY_CREATE_PROJECT: 'true',
  })
  assert.equal(created.vars.create_project, true)
  assert.deepEqual(application(values), output.vars.application_environment)
})

test('legacy defaults and public URL validation work before provisioning', () => {
  const defaults = { ...values, REDIRECTORY_GITHUB_REPOSITORY: '' }
  assert.ok(
    !Object.hasOwn(
      deployment(defaults).vars.application_environment,
      'REDIRECTORY_GITHUB_REPOSITORY',
    ),
  )
  for (const url of [
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?token=secret',
    'file:///tmp/test',
  ])
    assert.throws(() =>
      application({ ...defaults, REDIRECTORY_PUBLIC_URL: url }),
    )
  assert.doesNotThrow(() =>
    application({
      ...defaults,
      REDIRECTORY_PUBLIC_URL: 'https://conan.example.com',
    }),
  )
})

test('application and host ports are separate and validated', () => {
  const output = deployment({ ...values, PORT: '18080', HOST_PORT: '19090' })
  assert.equal(output.vars.port, 18080)
  assert.ok(!Object.hasOwn(output.vars.application_environment, 'PORT'))
  assert.ok(!Object.hasOwn(output.vars.application_environment, 'HOST_PORT'))
  for (const key of ['PORT', 'HOST_PORT'])
    for (const value of ['0', '65536', '1.5', 'invalid'])
      assert.throws(() => application({ ...values, [key]: value }))
})

const repositoryValues = {
  REDIRECTORY_GITHUB_REPOSITORY: 'example/packages',
  REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-secret',
}

test('repository preflight validates the public default branch without writes', async () => {
  const calls = []
  await validateRepository(repositoryValues, async (url, options) => {
    calls.push({ url, options })
    return Response.json(
      calls.length === 1
        ? { private: false, default_branch: 'release/main' }
        : { name: 'release/main' },
    )
  })
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.github.com/repos/example/packages',
      'https://api.github.com/repos/example/packages/branches/release%2Fmain',
    ],
  )
  for (const { options } of calls) {
    assert.equal(options.method, undefined)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-read-secret')
  }
})

test('repository preflight rejects an empty repository and hides upstream errors', async () => {
  let calls = 0
  await assert.rejects(
    validateRepository(repositoryValues, async () =>
      ++calls === 1
        ? Response.json({ private: false, default_branch: 'main' })
        : new Response('test-read-secret', { status: 404 }),
    ),
    /initial commit/,
  )
  await assert.rejects(
    validateRepository(repositoryValues, async () =>
      Response.json({ private: true, default_branch: 'main' }),
    ),
    /must be public/,
  )
  await assert.rejects(
    validateRepository(
      repositoryValues,
      async () => new Response('test-read-secret', { status: 401 }),
    ),
    (error) =>
      error.message.includes('HTTP 401') &&
      !error.message.includes('test-read-secret'),
  )
  await assert.rejects(
    validateRepository(repositoryValues, async () => {
      throw new Error('test-read-secret')
    }),
    (error) => !error.message.includes('test-read-secret'),
  )
})
