import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MetadataCache } from '../dist/cache.js'
import { GitHub } from '../dist/github.js'
import { configuration } from '../dist/config.js'
import { createApp } from '../dist/router.js'
import { fixture } from './mock-github.mjs'
import { issue } from '../dist/auth.js'
import { tag, assetName } from '../dist/model.js'

const config = configuration({
  REDIRECTORY_GITHUB_REPOSITORY: 'test/packages',
  REDIRECTORY_ENCRYPTION_KEY: '12'.repeat(32),
  REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
})

test('metadata reads coalesce, expire and obey entry and byte limits', async () => {
  let now = 0
  let calls = 0
  const cache = new MetadataCache(() => now, 10000, 2, 4)
  const load = async () => {
    calls++
    return new Response('12')
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, () => cache.get('a', load)),
  )
  assert.equal(calls, 1)
  assert.deepEqual(
    await Promise.all(results.map((x) => x.text())),
    Array(20).fill('12'),
  )
  now = 10001
  await cache.get('a', load)
  assert.equal(calls, 2)
  await cache.get('b', load)
  await cache.get('c', load)
  await cache.get('a', load)
  assert.equal(calls, 5)
  await cache.get('large', async () => new Response('12345'))
  await cache.get('large', async () => {
    calls++
    return new Response('12345')
  })
  assert.equal(calls, 6)
})

test('negative entries expire quickly, failures are not cached and invalidated in-flight reads cannot repopulate', async () => {
  let now = 0
  let calls = 0
  const cache = new MetadataCache(() => now)
  const missing = async () => {
    calls++
    return new Response('missing', { status: 404 })
  }
  await cache.get('missing', missing)
  await cache.get('missing', missing)
  assert.equal(calls, 1)
  now = 5001
  await cache.get('missing', missing)
  assert.equal(calls, 2)
  for (let i = 0; i < 2; i++)
    await cache.get('denied', async () => {
      calls++
      return new Response('denied', { status: 403 })
    })
  assert.equal(calls, 4)
  let complete
  const pending = cache.get(
    'racing',
    () => new Promise((resolve) => (complete = resolve)),
  )
  cache.clear()
  complete(new Response('old'))
  assert.equal(await (await pending).text(), 'old')
  assert.equal(
    await (await cache.get('racing', async () => new Response('new'))).text(),
    'new',
  )
  await assert.rejects(
    cache.get('failure', async () => {
      throw new Error('offline')
    }),
  )
  assert.equal(
    await (
      await cache.get('failure', async () => new Response('recovered'))
    ).text(),
    'recovered',
  )
})

test('cache never reuses authorization across credentials and login always revalidates', async (t) => {
  const { url, github } = await fixture(t, config)
  assert.equal((await fetch(url + '/v2/conans/search')).status, 200)
  const authorization =
    'Basic ' + Buffer.from('test:invalid-token').toString('base64')
  assert.equal(
    (
      await fetch(url + '/v2/users/authenticate', {
        headers: { authorization },
      })
    ).status,
    401,
  )
  const before = github.requests()
  const valid =
    'Basic ' + Buffer.from('test:test-write-token').toString('base64')
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await fetch(url + '/v2/users/authenticate', {
          headers: { authorization: valid },
        })
      ).status,
      200,
    )
  assert.equal(github.requests() - before, 2)
})

test('GitHub rate limits are diagnosed without credentials and returned as 429 with Retry-After', async (t) => {
  const logs = []
  const transport = async () =>
    new Response('private upstream detail secret-token', {
      status: 403,
      headers: {
        'x-ratelimit-limit': '1000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-used': '1000',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        'retry-after': '60',
        'x-github-request-id': 'ABCD:1234',
        'x-ratelimit-resource': 'core',
      },
    })
  const factory = (token) =>
    new GitHub(config, token, transport, undefined, undefined, {
      log: (line) => logs.push(line),
    })
  const server = createApp(config, factory, (line) => logs.push(line)).listen(
    0,
    '127.0.0.1',
  )
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v2/conans/search`,
  )
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.match(await response.text(), /rate limit exceeded/)
  const event = logs
    .map((x) => JSON.parse(x))
    .find((x) => x.event === 'github_request')
  assert.equal(event.status, 403)
  assert.equal(event.rate_limited, true)
  assert.equal(event.rate_remaining, 0)
  assert.equal(event.rate_limit, 1000)
  assert.equal(event.request_id, 'ABCD:1234')
  assert.equal(event.rate_resource, 'core')
  assert.doesNotMatch(
    logs.join('\n'),
    /secret-token|test-read-token|Authorization|private upstream detail/,
  )
  const denied = new GitHub(
    config,
    'secret-token',
    async () => new Response('secret-token', { status: 403 }),
  )
  await assert.rejects(
    denied.authorize(),
    (error) => error.code === 403 && error.message === 'GitHub request failed',
  )
})

test('publishing and removing a revision invalidate catalog and missing entries for every credential', async (t) => {
  const { github, url } = await fixture(t, config)
  const path = '/v2/conans/fresh/1.0/_/_/revisions/recipe'
  const query = '/v2/conans/search?q=fresh/*'
  const headers = {
    Authorization:
      'Bearer ' + issue(config, { user: 'test', token: 'test-write-token' }),
  }
  assert.deepEqual(await (await fetch(url + query)).json(), { results: [] })
  assert.equal((await fetch(url + path + '/files')).status, 404)
  assert.equal(
    (
      await fetch(url + path + '/files/conanfile.py', {
        method: 'PUT',
        headers,
        body: 'recipe',
      })
    ).status,
    201,
  )
  assert.equal(
    (await fetch(url + '/v2/conans/fresh/1.0/_/_/latest')).status,
    404,
  )
  assert.equal(
    (
      await fetch(url + path + '/files/conanmanifest.txt', {
        method: 'PUT',
        headers,
        body: 'manifest',
      })
    ).status,
    201,
  )
  assert.deepEqual(await (await fetch(url + query)).json(), {
    results: ['fresh/1.0'],
  })
  assert.equal(
    (await fetch(url + '/v2/conans/fresh/1.0/_/_/latest')).status,
    200,
  )
  assert.equal((await fetch(url + path + '/files')).status, 200)
  assert.equal(
    (await fetch(url + path, { method: 'DELETE', headers })).status,
    200,
  )
  assert.deepEqual(await (await fetch(url + query)).json(), { results: [] })
  assert.equal((await fetch(url + path + '/files')).status, 404)
  assert.equal(github.releases.length, 0)
})

test('large embedded asset lists use complete paginated results', async (t) => {
  const { github, url } = await fixture(t, config)
  const ref = {
    name: 'large',
    version: '1.0',
    user: '_',
    channel: '_',
    rrev: 'recipe',
  }
  github.releases.push({
    id: 10000,
    tag_name: tag(ref),
    created_at: '2026-01-01T00:00:00Z',
    body: JSON.stringify({ format: 'redirectory-v1', reference: ref }),
    assets: Array.from({ length: 101 }, (_, i) => ({
      id: i,
      state: 'uploaded',
      name: assetName(i === 100 ? 'conanmanifest.txt' : `file-${i}`),
      size: 1,
    })),
  })
  const response = await fetch(
    url + '/v2/conans/large/1.0/_/_/revisions/recipe/files',
  )
  assert.equal(response.status, 200)
  assert.equal(Object.keys((await response.json()).files).length, 101)
  assert.equal(
    github.history.filter((x) => x.path.endsWith('/assets')).length,
    2,
  )
})

test('concurrent searches over 137 releases share three GitHub calls without asset scans', async (t) => {
  const { github, url } = await fixture(t, config)
  for (let i = 0; i < 137; i++) {
    const ref = {
      name: `fixture-${i}`,
      version: '1.0',
      user: '_',
      channel: '_',
      rrev: 'recipe',
    }
    github.releases.push({
      id: 10000 + i,
      tag_name: tag(ref),
      created_at: '2026-01-01T00:00:00Z',
      body: JSON.stringify({ format: 'redirectory-v1', reference: ref }),
      assets: [
        {
          id: i,
          name: assetName('conanmanifest.txt'),
          state: 'uploaded',
          size: 1,
        },
      ],
    })
  }
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const response = await fetch(url + '/v2/conans/search?q=fixture-0/*')
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { results: ['fixture-0/1.0'] })
    }),
  )
  assert.equal(github.requests(), 3)
  assert.equal(
    github.history.filter((x) => x.path.endsWith('/assets')).length,
    0,
  )
  assert.equal(
    (await fetch(url + '/v2/conans/search?q=fixture-1/*')).status,
    200,
  )
  assert.equal(github.requests(), 3)
})
