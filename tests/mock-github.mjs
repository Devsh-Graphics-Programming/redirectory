import { createApp } from '../dist/router.js'
import express from 'express'
import { createHash } from 'node:crypto'
import { GitHub } from '../dist/github.js'

export async function mockGitHub(config, repository = 'test/packages') {
  const app = express()
  const releases = []
  const contents = new Map()
  let id = 0
  let requests = 0
  app.use((req, res, next) => {
    requests++
    if (
      !req.path.startsWith('/download/') &&
      ![
        'Bearer test-write-token',
        'Bearer test-read-token',
        'Bearer app-write-token',
        'Bearer app-read-token',
      ].includes(req.get('Authorization'))
    )
      return res.sendStatus(401)
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !['Bearer test-write-token', 'Bearer app-write-token'].includes(
        req.get('Authorization'),
      )
    )
      return res.sendStatus(403)
    next()
  })
  const base = '/repos/' + repository
  app.get('/user', (_req, res) => res.json({ login: 'test' }))
  app.get('/search/repositories', (_req, res) =>
    res.json({ items: [{ name: 'packages', owner: { login: 'test' } }] }),
  )
  app.get(base, (req, res) =>
    res.json({
      private: false,
      permissions: req.get('Authorization')?.startsWith('Bearer app-')
        ? undefined
        : { push: req.get('Authorization') === 'Bearer test-write-token' },
    }),
  )
  app.get(`${base}/releases`, (req, res) =>
    res.json(
      [...releases]
        .reverse()
        .slice((Number(req.query.page) - 1) * 100, Number(req.query.page) * 100)
        .map((release) => ({ ...release, assets: [] })),
    ),
  )
  app.get(`${base}/releases/tags/:tag`, (req, res) => {
    const release = releases.find((r) => r.tag_name === req.params.tag)
    if (!release) return res.sendStatus(404)
    res.json(release)
  })
  app.post(`${base}/releases`, express.json(), (req, res) => {
    if (releases.some((r) => r.tag_name === req.body.tag_name))
      return res.sendStatus(422)
    const release = {
      ...req.body,
      id: ++id,
      created_at: new Date().toISOString(),
      upload_url: `${url}${base}/releases/${id}/assets{?name,label}`,
      assets: [],
    }
    releases.push(release)
    res.status(201).json(release)
  })
  app.get(`${base}/releases/:id/assets`, (req, res) => {
    const release = releases.find((r) => r.id === Number(req.params.id))
    if (!release) return res.sendStatus(404)
    res.json(
      release.assets.slice(
        (Number(req.query.page) - 1) * 100,
        Number(req.query.page) * 100,
      ),
    )
  })
  app.patch(`${base}/releases/:id`, express.json(), (req, res) => {
    const release = releases.find((r) => r.id === Number(req.params.id))
    if (!release) return res.sendStatus(404)
    Object.assign(release, req.body)
    res.json(release)
  })
  app.delete(`${base}/releases/assets/:id`, (req, res) => {
    for (const release of releases) {
      const index = release.assets.findIndex(
        (a) => a.id === Number(req.params.id),
      )
      if (index >= 0) {
        contents.delete(release.assets[index].id)
        release.assets.splice(index, 1)
        return res.sendStatus(204)
      }
    }
    res.sendStatus(404)
  })
  app.post(`${base}/releases/:id/assets`, async (req, res) => {
    const release = releases.find((r) => r.id === Number(req.params.id))
    if (!release) return res.sendStatus(404)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    if (release.assets.some((a) => a.name === req.query.name))
      return res.sendStatus(422)
    const asset = {
      id: ++id,
      name: req.query.name,
      size: data.length,
      state: 'uploaded',
      created_at: new Date().toISOString(),
      digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
    }
    release.assets.push(asset)
    contents.set(asset.id, data)
    res.status(201).json(asset)
  })
  app.get('/download/:tag/:file', (req, res) => {
    const release = releases.find((r) => r.tag_name === req.params.tag)
    const asset = release?.assets.find((a) => a.name === req.params.file)
    if (!asset) return res.sendStatus(404)
    res.type('application/octet-stream').send(contents.get(asset.id))
  })
  app.delete(`${base}/releases/:id`, (req, res) => {
    const index = releases.findIndex((r) => r.id === Number(req.params.id))
    if (index < 0) return res.sendStatus(404)
    for (const asset of releases[index].assets) contents.delete(asset.id)
    releases.splice(index, 1)
    res.sendStatus(204)
  })
  app.delete(`${base}/git/refs/tags/:tag`, (_req, res) => res.sendStatus(204))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  class LocalGitHub extends GitHub {
    downloadUrl(ref, name) {
      const production = new URL(super.downloadUrl(ref, name))
      return (
        url + '/download/' + production.pathname.split('/').slice(-2).join('/')
      )
    }
  }
  return {
    releases,
    contents,
    requests: () => requests,
    legacyOptions: {
      api: url,
      uploads: url,
      downloadUrl: (_repo, level, name) =>
        `${url}/download/${encodeURIComponent(level.tag)}/${name}`,
    },
    factory: (token) => new LocalGitHub(config, token, fetch, url, url),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function fixture(t, config) {
  const github = await mockGitHub(config)
  const logs = []
  const server = createApp(
    config,
    github.factory,
    (line) => logs.push(line),
    github.legacyOptions,
  ).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await github.close()
  })
  return { github, logs, url: 'http://127.0.0.1:' + server.address().port }
}
