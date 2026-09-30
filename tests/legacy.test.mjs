import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../dist/config.js'
import { createApp } from '../dist/router.js'
import { mockGitHub, fixture } from './mock-github.mjs'
import { grant } from '../dist/auth.js'

test('default mode preserves upstream repository mapping, metadata and Conan 1 upload grants', async (t) => {
  const config = configuration({
    REDIRECTORY_ENCRYPTION_KEY: 'ab'.repeat(32),
    REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
  })
  assert.equal(config.repository, '')
  const { github, logs, url } = await fixture(t, config)
  const login = await fetch(url + '/v1/users/authenticate', {
    headers: {
      Authorization:
        'Basic ' + Buffer.from('test:test-write-token').toString('base64'),
    },
  })
  assert.equal(login.status, 200)
  const session = await login.text(),
    headers = { Authorization: 'Bearer ' + session }
  const base = '/v1/conans/packages/1.0/github/test'
  const r = await fetch(url + base + '/upload_urls', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'conanfile.py': 4, 'conanmanifest.txt': 8 }),
  })
  assert.equal(r.status, 200)
  const urls = await r.json()
  for (const value of Object.values(urls)) {
    assert.ok(!value.includes('test-write-token'))
    assert.ok(!value.includes('&auth='))
  }
  const upload = await fetch(urls['conanfile.py'], {
    method: 'PUT',
    body: 'test',
  })
  assert.equal(upload.status, 201)
  assert.equal(
    (
      await fetch(urls['conanmanifest.txt'], {
        method: 'PUT',
        body: 'manifest',
      })
    ).status,
    201,
  )
  const root = github.releases.find((x) => x.tag_name === '1.0')
  assert.ok(root)
  assert.ok(
    root.body.includes(
      '<!--redirectory\nDo not edit or remove this comment.\n',
    ),
  )
  const metadata = JSON.parse(
    root.body.slice(root.body.indexOf('{'), root.body.lastIndexOf('}') + 1),
  )
  assert.equal(metadata.revisions[0].id, '0')
  assert.equal(
    metadata.revisions[0].release.assets['conanfile.py'].md5,
    '098f6bcd4621d373cade4e832627b4f6',
  )
  assert.equal(root.assets[0].name, 'conanfile.py')
  assert.equal((await fetch(url + base)).status, 200)
  const urlsResponse = await fetch(url + base + '/download_urls')
  assert.equal(urlsResponse.status, 200)
  const download = await urlsResponse.json()
  assert.equal(await (await fetch(download['conanfile.py'])).text(), 'test')
  const before = root.body
  assert.equal(
    (await fetch(url + '/v2/conans/packages/1.0/github/test/latest')).status,
    200,
  )
  assert.equal(root.body, before)
  assert.equal(
    (await fetch(url + '/v2/conans/packages/1.0/_/_/latest')).status,
    404,
  )
  assert.equal(
    (await fetch(url + '/v2/conans/other/1.0/github/test/latest')).status,
    404,
  )
  const wrongSize = await fetch(urls['conanfile.py'], {
    method: 'PUT',
    body: 'wrong',
  })
  assert.equal(wrongSize.status, 401)
  const wrongPath = await fetch(
    urls['conanfile.py'].replace('/conanfile.py?', '/other.py?'),
    { method: 'PUT', body: 'test' },
  )
  assert.equal(wrongPath.status, 401)
  const wrongMethod = await fetch(urls['conanfile.py'])
  assert.equal(wrongMethod.status, 401)
  const tampered = new URL(urls['conanfile.py'])
  const bytes = Buffer.from(tampered.searchParams.get('signature'), 'base64url')
  bytes[20] ^= 1
  tampered.searchParams.set('signature', bytes.toString('base64url'))
  assert.equal(
    (await fetch(tampered, { method: 'PUT', body: 'test' })).status,
    401,
  )
  const expired = new URL(urls['conanfile.py'])
  expired.searchParams.set(
    'signature',
    grant(
      config,
      { user: 'test', token: 'test-write-token' },
      expired.pathname,
      4,
      Date.now() - 3600000,
    ),
  )
  assert.equal(
    (await fetch(expired, { method: 'PUT', body: 'test' })).status,
    401,
  )
  for (const line of logs)
    assert.ok(
      !line.includes('test-write-token') && !line.includes('signature='),
    )
  assert.equal(
    (await fetch(url + base, { method: 'DELETE', headers })).status,
    200,
  )
  assert.deepEqual(
    JSON.parse(
      root.body.slice(root.body.indexOf('{'), root.body.lastIndexOf('}') + 1),
    ).revisions,
    [],
  )
})

test('existing upstream metadata works across repositories and survives writes', async (t) => {
  const config = configuration({
    REDIRECTORY_ENCRYPTION_KEY: 'ab'.repeat(32),
    REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
  })
  const first = await mockGitHub(config),
    second = await mockGitHub(config, 'another/library')
  const options = {
    ...first.legacyOptions,
    downloadUrl: undefined,
    transport: (url, init) => {
      const parsed = new URL(url)
      const origin = parsed.pathname.startsWith('/repos/another/library')
        ? second.legacyOptions.api
        : first.legacyOptions.api
      return fetch(origin + parsed.pathname + parsed.search, init)
    },
  }
  const time = '2020-01-02T03:04:05.000Z'
  const metadata = {
    revisions: [
      {
        id: 'abcdef',
        time,
        packages: [
          {
            id: '123abc',
            revisions: [
              {
                id: 'fedcba',
                time,
                release: {
                  id: 703,
                  origin: 'https://uploads.github.com',
                  assets: {
                    'conan_package.tgz': {
                      md5: 'old-binary-hash',
                      url: 'https://untrusted.invalid/asset',
                    },
                  },
                },
              },
            ],
          },
        ],
        release: {
          id: 702,
          origin: 'https://uploads.github.com',
          assets: {
            'conanmanifest.txt': {
              md5: 'old-manifest-hash',
              url: 'https://untrusted.invalid/manifest',
            },
          },
        },
      },
    ],
  }
  const body =
    'Existing release notes\n<!--redirectory\nDo not edit or remove this comment.\n' +
    JSON.stringify(metadata, null, 2) +
    '\n-->\nExisting footer'
  for (const github of [first, second])
    github.releases.push(
      { id: 701, tag_name: '1.0', body, assets: [] },
      { id: 702, tag_name: '1.0#abcdef', assets: [] },
      { id: 703, tag_name: '1.0#abcdef@123abc#fedcba', assets: [] },
    )
  const server = createApp(config, undefined, () => {}, options).listen(
    0,
    '127.0.0.1',
  )
  await new Promise((r) => server.once('listening', r))
  t.after(async () => {
    await new Promise((r) => server.close(r))
    await first.close()
    await second.close()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  for (const [name, owner] of [
    ['packages', 'test'],
    ['library', 'another'],
  ]) {
    const base = `/v2/conans/${name}/1.0/github/${owner}`
    assert.deepEqual(await (await fetch(url + base + '/latest')).json(), {
      revision: 'abcdef',
      time,
    })
    assert.deepEqual(
      await (
        await fetch(url + base + '/revisions/abcdef/packages/123abc/latest')
      ).json(),
      { revision: 'fedcba', time },
    )
    assert.deepEqual(
      await (await fetch(url + base + '/revisions/abcdef/files')).json(),
      { files: { 'conanmanifest.txt': {} } },
    )
    const download = await fetch(
      url +
        base +
        '/revisions/abcdef/packages/123abc/revisions/fedcba/files/conan_package.tgz',
      { redirect: 'manual' },
    )
    assert.equal(download.status, 301)
    assert.equal(
      download.headers.get('location'),
      `https://github.com/${owner}/${name}/releases/download/1.0%23abcdef%40123abc%23fedcba/conan_package.tgz`,
    )
  }
  assert.equal(first.releases[0].body, body)
  const session = await (
    await fetch(url + '/v2/users/authenticate', {
      headers: {
        Authorization:
          'Basic ' + Buffer.from('test:test-write-token').toString('base64'),
      },
    })
  ).text()
  const write = await fetch(
    url +
      '/v2/conans/library/1.0/github/another/revisions/abcdef/files/conanfile.py',
    {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + session },
      body: 'recipe',
    },
  )
  assert.equal(write.status, 201)
  assert.equal(first.releases[0].body, body)
  const updated = second.releases[0].body
  assert.ok(updated.startsWith('Existing release notes\n<!--redirectory\n'))
  assert.ok(updated.endsWith('\n-->\nExisting footer'))
  const parsed = JSON.parse(
    updated.slice(updated.indexOf('{'), updated.lastIndexOf('}') + 1),
  )
  assert.deepEqual(parsed.revisions[0].packages, metadata.revisions[0].packages)
  assert.equal(
    parsed.revisions[0].release.assets['conanmanifest.txt'].md5,
    'old-manifest-hash',
  )
  assert.ok(parsed.revisions[0].release.assets['conanfile.py'])
})

test('upstream permission failures do not become missing releases or create attempts', async (t) => {
  const config = configuration({
    REDIRECTORY_ENCRYPTION_KEY: 'ab'.repeat(32),
    REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
  })
  const github = await mockGitHub(config)
  let writes = 0
  const transport = (url, options) => {
    if (options.method === 'POST') writes++
    if (new URL(url).pathname.includes('/releases/tags/'))
      return Promise.resolve(
        new Response('private upstream detail', { status: 403 }),
      )
    return fetch(url, options)
  }
  const server = createApp(config, undefined, () => {}, {
    ...github.legacyOptions,
    transport,
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await github.close()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const session = await (
    await fetch(url + '/v2/users/authenticate', {
      headers: {
        Authorization:
          'Basic ' + Buffer.from('test:test-write-token').toString('base64'),
      },
    })
  ).text()
  for (const [path, options] of [
    ['/v2/conans/packages/1.0/github/test/latest', {}],
    [
      '/v2/conans/packages/1.0/github/test/revisions/abc/files/conanfile.py',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + session },
        body: 'recipe',
      },
    ],
  ]) {
    const response = await fetch(url + path, options)
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'GitHub request failed')
  }
  assert.equal(writes, 0)
})
