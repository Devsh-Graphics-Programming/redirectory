import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  })
  if (result.error || result.status !== 0) throw new Error(command + ' failed')
  return result.stdout?.trim()
}

async function smoke(image) {
  if (!image) throw new Error('Pass the image to test')
  const port = 18080
  const name = 'redirectory-smoke-' + randomBytes(5).toString('hex')
  const env = {
    ...process.env,
    REDIRECTORY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  }
  const docker = (args) =>
    run('docker', args, { env, encoding: 'utf8', stdio: 'pipe' })
  try {
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--memory=256m',
      '--cpus=0.14',
      '-p',
      `127.0.0.1::${port}`,
      '-e',
      `PORT=${port}`,
      '-e',
      'REDIRECTORY_ENCRYPTION_KEY',
      '-e',
      'REDIRECTORY_GITHUB_REPOSITORY=test/packages',
      image,
    ])
    const binding = JSON.parse(docker(['inspect', name]))[0].NetworkSettings
      .Ports[`${port}/tcp`][0]
    const url = `http://127.0.0.1:${binding.HostPort}/healthz`
    let healthy = false
    for (let i = 0; i < 60; i++) {
      try {
        healthy = (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok
      } catch {}
      if (healthy) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!healthy) throw new Error('Health check did not succeed')
    docker(['exec', name, 'node', 'scripts/container.mjs'])
    if (docker(['exec', name, 'id', '-u']) === '0')
      throw new Error('Container runs as root')
    docker(['stop', '-t', '30', name])
    if (JSON.parse(docker(['inspect', name]))[0].State.ExitCode !== 0)
      throw new Error('Unclean shutdown')
    if (docker(['logs', name]).includes(env.REDIRECTORY_ENCRYPTION_KEY))
      throw new Error('Secret leaked into logs')
    console.log(
      'PASS: non-root, read-only container at 256 MB / 0.14 CPU, health check and graceful shutdown',
    )
  } finally {
    spawnSync('docker', ['rm', '-f', name], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
}

if (process.argv[2] === '--infra') {
  const image = 'ghcr.io/opentofu/opentofu:1.12.6'

  function tofu(directory, args) {
    run(
      'docker',
      [
        'run',
        '--rm',
        '--mount',
        `type=bind,source=${resolve('.')},target=/app`,
        '-w',
        `/app/${directory}`,
        image,
        ...args,
      ],
      { stdio: 'inherit', windowsHide: true },
    )
  }

  tofu('', ['fmt', '-check', '-recursive', 'infra'])
  for (const directory of ['infra/scaleway', 'infra/scaleway/domain']) {
    tofu(directory, ['init', '-backend=false', '-input=false'])
    tofu(directory, ['validate'])
    tofu(directory, ['test'])
  }
} else if (process.argv[2] === '--smoke') {
  await smoke(process.argv[3])
} else {
  const testImage = 'redirectory:test'
  const runtimeImage = 'redirectory:local'

  run('docker', ['build', '--target', 'e2e', '-t', testImage, '.'])
  run('docker', ['run', '--rm', testImage])
  run('docker', ['build', '--target', 'runtime', '-t', runtimeImage, '.'])
  await smoke(runtimeImage)
}
