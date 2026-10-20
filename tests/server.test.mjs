import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { configuration } from '../dist/config.js'
import { basic, bearer, issue } from '../dist/auth.js'
import {
  tag,
  filename,
  assetName,
  emptyAssetName,
  emptyOriginalName,
  originalName,
} from '../dist/model.js'
import { fixture } from './mock-github.mjs'

const config = configuration({
  REDIRECTORY_GITHUB_REPOSITORY: 'test/packages',
  REDIRECTORY_ENCRYPTION_KEY: '12'.repeat(32),
  REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
})
const credentials = { user: 'test', token: 'test-write-token' }

test('installation tokens rely on GitHub to enforce write permissions', async (t) => {
  const { github, url } = await fixture(t, config)
  for (const [token, status] of [
    ['app-read-token', 403],
    ['app-write-token', 201],
  ]) {
    const response = await fetch(
      url + '/v2/conans/app/1/_/_/revisions/abc/files/conanfile.py',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + issue(config, { user: 'test', token }),
        },
        body: 'recipe',
      },
    )
    assert.equal(response.status, status)
    assert.equal(github.releases.length, status === 201 ? 1 : 0)
  }
})

test('asset names preserve metadata paths and reject traversal', () => {
  for (const name of ['conanfile.py', 'metadata/sign/signature']) {
    assert.equal(originalName(assetName(name)), name)
    assert.equal(emptyOriginalName(emptyAssetName(name)), name)
  }
  for (const name of [
    '../secret',
    '/absolute',
    'metadata/../secret',
    'path\\secret',
    'a?auth=secret',
  ])
    assert.throws(() => filename(name))
})

test('empty Conan files use markers and download as zero bytes', async (t) => {
  const { github, url } = await fixture(t, config)
  const headers = {
    Authorization:
      'Bearer ' + issue(config, { user: 'test', token: 'test-write-token' }),
  }
  const recipe = '/v2/conans/header/1.0/_/_/revisions/recipe'
  const revision =
    recipe +
    '/packages/da39a3ee5e6b4b0d3255bfef95601890afd80709/revisions/package'
  const put = (name, body, extra = {}) =>
    fetch(url + revision + '/files/' + name, {
      method: 'PUT',
      headers: { ...headers, ...extra },
      body,
      duplex: 'half',
    })
  const putEmpty = (extra = {}) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        url + revision + '/files/conaninfo.txt',
        {
          method: 'PUT',
          headers: {
            ...headers,
            'Transfer-Encoding': 'chunked',
            ...extra,
          },
        },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        },
      )
      request.once('error', reject)
      request.end()
    })
  assert.equal(await putEmpty(), 411)
  const checksum = {
    'X-Checksum-Sha1': 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  }
  assert.equal(await putEmpty(checksum), 201)
  assert.equal(await putEmpty(checksum), 201)
  assert.equal((await put('conan_package.tgz', 'archive')).status, 201)
  assert.equal((await put('conanmanifest.txt', 'manifest')).status, 201)
  const release = github.releases.find((item) => item.name.includes(':da39a3'))
  assert.ok(release)
  assert.ok(
    release.assets.some(
      (asset) => asset.name === emptyAssetName('conaninfo.txt'),
    ),
  )
  assert.ok(!release.assets.some((asset) => asset.size === 0))
  const files = await (await fetch(url + revision + '/files')).json()
  assert.deepEqual(Object.keys(files.files).sort(), [
    'conan_package.tgz',
    'conaninfo.txt',
    'conanmanifest.txt',
  ])
  const download = await fetch(url + revision + '/files/conaninfo.txt', {
    redirect: 'manual',
  })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-length'), '0')
  assert.equal((await download.arrayBuffer()).byteLength, 0)
  const search = await (await fetch(url + recipe + '/search')).json()
  assert.deepEqual(search, {
    da39a3ee5e6b4b0d3255bfef95601890afd80709: {
      settings: {},
      options: {},
      requires: [],
    },
  })
})

test('disabled anonymous reads, upload limits and upstream error redaction', async (t) => {
  const restricted = { ...config, anonymousRead: false, maxUploadBytes: 3 }
  const { github, url } = await fixture(t, restricted)
  assert.equal((await fetch(url + '/v2/conans/search')).status, 401)
  assert.equal(github.requests(), 0)
  const denied = await fetch(url + '/v2/users/authenticate', {
    headers: {
      Authorization:
        'Basic ' + Buffer.from('test:unknown-secret').toString('base64'),
    },
  })
  assert.equal(denied.status, 401)
  assert.ok(!(await denied.text()).includes('unknown-secret'))
  const response = await fetch(
    url + '/v2/conans/a/1/_/_/revisions/abc/files/conanfile.py',
    {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + issue(restricted, credentials) },
      body: 'four',
    },
  )
  assert.equal(response.status, 413)
  assert.equal(github.releases.length, 0)
})

test('encrypted sessions reject tampering, expiry, wrong key and repository', () => {
  const session = issue(config, credentials, 1000)
  const tampered = Buffer.from(session, 'base64url')
  tampered[0] ^= 1
  assert.deepEqual(bearer(config, 'Bearer ' + session, 1001), credentials)
  assert.ok(!session.includes(credentials.token))
  assert.ok(
    !Buffer.from(session, 'base64url').includes(Buffer.from(credentials.token)),
  )
  for (const [cfg, value, now] of [
    [config, session, 1801000],
    [config, tampered.toString('base64url'), 1001],
    [{ ...config, repository: 'other/repo' }, session, 1001],
    [{ ...config, key: Buffer.alloc(32) }, session, 1001],
  ])
    assert.throws(() => bearer(cfg, 'Bearer ' + value, now))
  for (const header of [
    undefined,
    '',
    'Basic !!!',
    'Basic ' + Buffer.from('user:').toString('base64'),
  ])
    assert.throws(() => basic(header))
  assert.throws(() => configuration({}))
})

test('real HTTP routes, parallel uploads, retries, isolation, auth and redaction', async (t) => {
  const { github, url, logs } = await fixture(t, config)
  const health = await fetch(url + '/healthz')
  assert.equal(health.status, 200)
  assert.equal(github.requests(), 0)
  const login = await fetch(url + '/v2/users/authenticate', {
    headers: {
      Authorization:
        'Basic ' + Buffer.from('test:test-write-token').toString('base64'),
    },
  })
  assert.equal(login.status, 200)
  const session = await login.text()
  const headers = { Authorization: 'Bearer ' + session }
  const path = '/v2/conans/alpha/1.0/_/_/revisions/abc'
  const put = (root, name, body, auth = headers) =>
    fetch(url + root + '/files/' + name, { method: 'PUT', headers: auth, body })
  assert.equal((await put(path, 'conanfile.py', 'recipe', {})).status, 401)
  assert.equal(github.releases.length, 0)
  assert.equal(
    (
      await put(path, 'conanfile.py', 'recipe', {
        Authorization: 'Bearer broken',
      })
    ).status,
    401,
  )
  const parallel = await Promise.all([
    put(path, 'conanfile.py', 'recipe'),
    put(path, 'conan_export.tgz', 'archive'),
  ])
  assert.deepEqual(
    parallel.map((r) => r.status),
    [201, 201],
  )
  assert.equal(github.releases.length, 1)
  assert.equal((await fetch(url + path + '/files')).status, 404)
  assert.equal((await put(path, 'conanmanifest.txt', 'manifest')).status, 201)
  assert.equal((await put(path, 'conanfile.py', 'recipe')).status, 201)
  assert.equal((await put(path, 'conanfile.py', 'changed')).status, 409)
  const files = await (await fetch(url + path + '/files')).json()
  assert.deepEqual(Object.keys(files.files).sort(), [
    'conan_export.tgz',
    'conanfile.py',
    'conanmanifest.txt',
  ])
  const redirect = await fetch(url + path + '/files/conanfile.py', {
    redirect: 'manual',
  })
  assert.equal(redirect.status, 302)
  assert.ok(!redirect.headers.get('location').includes(credentials.token))
  assert.equal(
    await (await fetch(redirect.headers.get('location'))).text(),
    'recipe',
  )
  const beta = path.replace('alpha', 'beta')
  await put(beta, 'conanmanifest.txt', 'second')
  const refs = await (await fetch(url + '/v2/conans/search?q=*')).json()
  assert.deepEqual(refs.results.sort(), ['alpha/1.0', 'beta/1.0'])
  assert.equal(
    (await fetch(url + path.replace('/revisions/abc', '/latest'))).status,
    200,
  )
  assert.equal(
    (await fetch(url + path + '?auth=test-write-token', { method: 'DELETE' }))
      .status,
    401,
  )
  const readOnly = issue(config, { user: 'test', token: 'test-read-token' })
  assert.equal(
    (
      await put(beta, 'conanfile.py', 'bad', {
        Authorization: 'Bearer ' + readOnly,
      })
    ).status,
    403,
  )
  assert.equal(
    (await fetch(url + path, { method: 'DELETE', headers })).status,
    200,
  )
  assert.equal(github.releases.length, 1)
  assert.ok(!logs.join('').includes(credentials.token))
  assert.ok(!logs.join('').includes(session))
  assert.ok(!logs.join('').includes('auth='))
  assert.notEqual(
    tag({ name: 'alpha', version: '1', user: '_', channel: '_' }),
    tag({ name: 'beta', version: '1', user: '_', channel: '_' }),
  )
})

test('versions, recipe revisions and binary revisions remain isolated through listing and deletion', async (t) => {
  const { github, url } = await fixture(t, config)
  const headers = {
    Authorization:
      'Bearer ' + issue(config, { user: 'test', token: 'test-write-token' }),
  }
  const base = '/v2/conans/alpha/1.0/_/_'
  const older = base + '/revisions/aaa'
  const newer = base + '/revisions/bbb'
  const binary = newer + '/packages/package1'
  const upload = async (path, file, content) =>
    assert.equal(
      (
        await fetch(url + path + '/files/' + file, {
          method: 'PUT',
          headers,
          body: content,
        })
      ).status,
      201,
    )
  await upload(older, 'conanmanifest.txt', 'older recipe')
  await upload(newer, 'conanmanifest.txt', 'newer recipe')
  await upload(
    older.replace('/1.0/', '/2.0/'),
    'conanmanifest.txt',
    'other version',
  )
  await upload(binary + '/revisions/old', 'conanmanifest.txt', 'older binary')
  await upload(binary + '/revisions/new', 'conanmanifest.txt', 'newer binary')
  await upload(binary + '/revisions/partial', 'conaninfo.txt', 'incomplete')
  for (let i = 0; i < github.releases.length; i++) {
    github.releases[i].created_at = '2025-01-01T00:00:00Z'
    github.releases[i].published_at = `2026-01-0${i + 1}T00:00:00Z`
  }
  const json = async (path) => {
    const response = await fetch(url + path)
    assert.equal(response.status, 200)
    return response.json()
  }
  assert.equal((await json(base + '/latest')).revision, 'bbb')
  assert.deepEqual(
    (await json(base + '/revisions')).revisions.map((r) => r.revision),
    ['bbb', 'aaa'],
  )
  assert.equal((await json(binary + '/latest')).revision, 'new')
  assert.deepEqual(
    (await json(binary + '/revisions')).revisions.map((r) => r.revision),
    ['new', 'old'],
  )
  assert.equal(
    (await fetch(url + binary + '/revisions/partial/files')).status,
    404,
  )
  assert.equal(
    (await fetch(url + newer, { method: 'DELETE', headers })).status,
    200,
  )
  assert.equal((await json(base + '/latest')).revision, 'aaa')
  assert.deepEqual((await json('/v2/conans/search?q=*')).results.sort(), [
    'alpha/1.0',
    'alpha/2.0',
  ])
  assert.equal(github.releases.length, 2)
})
