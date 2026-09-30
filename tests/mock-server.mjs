import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { configuration } from '../dist/config.js'
import { createApp } from '../dist/router.js'
import { mockGitHub } from './mock-github.mjs'

for (const legacy of [false, true]) {
  const config = configuration({
    REDIRECTORY_GITHUB_REPOSITORY: legacy ? '' : 'test/packages',
    REDIRECTORY_ENCRYPTION_KEY: '12'.repeat(32),
    REDIRECTORY_GITHUB_READ_TOKEN: 'test-read-token',
  })
  const mock = await mockGitHub(config)
  const logs = []
  const server = createApp(
    config,
    mock.factory,
    (line) => logs.push(line),
    mock.legacyOptions,
  ).listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const remote = 'http://127.0.0.1:' + server.address().port
    const modes = legacy
      ? [
          [],
          ['--conan', '/opt/conan1/bin/conan', '--conan1'],
          ['--conan', '/opt/conan1/bin/conan', '--conan1', '--revisions', '0'],
        ]
      : [[]]
    for (const mode of modes) {
      const child = spawn(
        'python',
        [
          'tests/e2e.py',
          '--remote',
          remote,
          '--allow-remote-writes',
          ...(legacy
            ? ['--legacy-owner', 'test', '--legacy-repository', 'packages']
            : []),
          ...mode,
        ],
        {
          stdio: 'inherit',
          env: { ...process.env, REDIRECTORY_TEST_TOKEN: 'test-write-token' },
        },
      )
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, 'Conan client failed')
    }
    assert.doesNotMatch(
      logs.join('\n'),
      /test-write-token|test-read-token|Authorization/,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await mock.close()
  }
}
