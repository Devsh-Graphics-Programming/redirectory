import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { configuration } from '../dist/config.js'
import { tag, assetName } from '../dist/model.js'
import { mockGitHub } from './mock-github.mjs'

const implementation = resolve(
  process.env.REDIRECTORY_TEST_IMPLEMENTATION || 'dist',
)
const { GitHub } = await import(
  pathToFileURL(resolve(implementation, 'github.js'))
)
const { createApp } = await import(
  pathToFileURL(resolve(implementation, 'router.js'))
)
const config = configuration({
  REDIRECTORY_GITHUB_REPOSITORY: 'test/packages',
  REDIRECTORY_ENCRYPTION_KEY: '12'.repeat(32),
  REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
})
const logs = []
const mock = await mockGitHub(config, 'test/packages', {
  GitHubClass: GitHub,
  log: (line) => logs.push(line),
})
for (let i = 0; i < 137; i++) {
  const ref = {
    name: `fixture-${i}`,
    version: '1.0',
    user: '_',
    channel: '_',
    rrev: 'recipe',
  }
  mock.releases.push({
    id: 10000 + i,
    tag_name: tag(ref),
    body: JSON.stringify({ format: 'redirectory-v1', reference: ref }),
    created_at: '2026-01-01T00:00:00Z',
    assets: [
      {
        id: 20000 + i,
        name: assetName('conanmanifest.txt'),
        state: 'uploaded',
        size: 1,
      },
    ],
  })
}
const server = createApp(config, mock.factory, (line) =>
  logs.push(line),
).listen(0, '127.0.0.1')
await once(server, 'listening')
const remote = `http://127.0.0.1:${server.address().port}`
const phases = {}
const measure = async (name, fn) => {
  const before = mock.history.length
  await fn()
  const history = mock.history.slice(before)
  phases[name] = {
    github_api: history.filter((x) => !x.path.startsWith('/download/')).length,
    asset_downloads: history.filter((x) => x.path.startsWith('/download/'))
      .length,
  }
}
try {
  const search = async () => {
    const response = await fetch(remote + '/v2/conans/search?q=fixture-0/*')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { results: ['fixture-0/1.0'] })
  }
  await measure('search_cold', search)
  await measure('search_warm', search)
  await measure('missing_binaries', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await fetch(
        remote +
          `/v2/conans/fixture-0/1.0/_/_/revisions/recipe/packages/missing-${i}/latest`,
      )
      assert.equal(r.status, 404)
      await r.text()
    }
  })
  mock.cache.clear()
  await measure('parallel_cold_searches', () =>
    Promise.all(Array.from({ length: 10 }, search)),
  )
  await measure('conan_e2e', async () => {
    const child = spawn(
      process.env.REDIRECTORY_TEST_PYTHON || 'python',
      [
        'tests/e2e.py',
        '--remote',
        remote,
        '--allow-remote-writes',
        '--conan',
        process.env.REDIRECTORY_TEST_CONAN || 'conan',
      ],
      {
        env: { ...process.env, REDIRECTORY_TEST_TOKEN: 'test-write-token' },
        windowsHide: true,
      },
    )
    let output = ''
    child.stdout.on('data', (x) => (output += x))
    child.stderr.on('data', (x) => (output += x))
    const [code] = await once(child, 'exit')
    mkdirSync('tmp', { recursive: true })
    const label = process.env.REDIRECTORY_TEST_LABEL || 'after'
    writeFileSync(
      `tmp/request-counts-${label}.log`,
      output.replaceAll('test-write-token', '[REDACTED]'),
    )
    assert.equal(
      code,
      0,
      `Conan E2E failed. See tmp/request-counts-${label}.log`,
    )
  })
  assert.equal(
    mock.releases.length,
    137,
    'Conan E2E must remove all uploaded fixtures',
  )
  assert.doesNotMatch(
    logs.join('\n'),
    /test-write-token|test-read-token|Authorization/,
  )
  const result = { seeded_releases: 137, phases }
  if (implementation === resolve('dist')) {
    assert.equal(phases.search_cold.github_api, 3)
    assert.equal(phases.search_warm.github_api, 0)
    assert.equal(phases.missing_binaries.github_api, 0)
    assert.equal(phases.parallel_cold_searches.github_api, 3)
    assert.ok(
      phases.conan_e2e.github_api < 200,
      'Conan request amplification regressed',
    )
  }
  writeFileSync(
    `tmp/request-counts-${process.env.REDIRECTORY_TEST_LABEL || 'after'}.json`,
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result))
} finally {
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
}
