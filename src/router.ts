import express from 'express'
import type { Config } from './config.js'
import { basic, bearer, issue } from './auth.js'
import { GitHub } from './github.js'
import { display, filename, originalName, reference } from './model.js'
import { Error as HttpError } from './http.js'
import { createLegacyRouter } from './legacy/router.js'

export type Factory = (token?: string) => GitHub

export function createApp(
  config: Config,
  factory: Factory = (token) => new GitHub(config, token),
  log: (line: string) => void = console.log,
  legacyOptions = {},
) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  app.use((req, res, next) => {
    const start = Date.now()
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    res.on('finish', () =>
      log(
        JSON.stringify({
          method: ['GET', 'PUT', 'DELETE', 'POST', 'HEAD'].includes(req.method)
            ? req.method
            : 'OTHER',
          status: res.statusCode,
          duration_ms: Date.now() - start,
        }),
      ),
    )
    next()
  })
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))
  if (!config.repository) app.use(createLegacyRouter(config, legacyOptions))
  app.get(['/v1/ping', '/v2/ping'], (_req, res) =>
    res.set('X-Conan-Server-Capabilities', 'revisions').send(),
  )
  app.get('/v2/users/authenticate', async (req, res) => {
    const credentials = basic(req.get('Authorization'))
    await factory(credentials.token).authorize()
    res.type('text/plain').send(issue(config, credentials))
  })
  app.get('/v2/users/check_credentials', async (req, res) => {
    const credentials = bearer(config, req.get('Authorization'))
    await factory(credentials.token).authorize()
    res.type('text/plain').send(credentials.user)
  })
  app.use('/v2', async (req, res, next) => {
    const header = req.get('Authorization')
    if (header) res.locals.token = bearer(config, header).token
    else if (!config.anonymousRead || !['GET', 'HEAD'].includes(req.method))
      throw new HttpError(401, 'Authentication required')
    else res.locals.token = config.readToken
    await factory(res.locals.token).authorize()
    next()
  })
  const base = '/v2/conans/:name/:version/:user/:channel'
  const recipe = `${base}/revisions/:rrev`
  const pkg = `${recipe}/packages/:package`
  const revision = `${pkg}/revisions/:prev`
  app.get('/v2/conans/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '*'
    if (query.length > 512) throw new HttpError(400, 'Search too long')
    const pattern = new RegExp(
      '^' +
        query
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
      req.query.ignorecase === 'False' ? '' : 'i',
    )
    const releases = await factory(res.locals.token).list()
    res.json({
      results: [
        ...new Set(
          releases.filter((r) => !r.ref!.package).map((r) => display(r.ref!)),
        ),
      ].filter((value) => pattern.test(value)),
    })
  })
  const revisions: express.RequestHandler = async (req, res) => {
    const ref = reference(req.params)
    const releases = (await factory(res.locals.token).list(ref)).filter((r) =>
      ref.package ? Boolean(r.ref!.prev) : !r.ref!.package,
    )
    if (!releases.length) throw new HttpError(404, 'Revision not found')
    const values = releases.map((r) => ({
      revision: ref.package ? r.ref!.prev : r.ref!.rrev,
      time: r.published_at || r.created_at,
    }))
    res.json(req.path.endsWith('/latest') ? values[0] : { revisions: values })
  }
  for (const path of [base, pkg]) {
    app.get(`${path}/latest`, revisions)
    app.get(`${path}/revisions`, revisions)
  }
  app.get(`${recipe}/search`, async (req, res) => {
    const github = factory(res.locals.token)
    const releases = (await github.list(reference(req.params))).filter(
      (r) => r.ref!.package,
    )
    const result: Record<string, unknown> = {}
    for (const release of releases) {
      const ref = release.ref!
      if (result[ref.package!]) continue
      if (req.query.list_only === 'True') result[ref.package!] = {}
      else {
        const content = await github.content(ref, 'conaninfo.txt')
        const info: Record<string, unknown> = {
          settings: {},
          options: {},
          requires: [],
        }
        let section = ''
        for (const raw of content.split('\n')) {
          const line = raw.trim()
          if (/^\[.*\]$/.test(line)) section = line.slice(1, -1)
          else if (line && ['settings', 'options'].includes(section)) {
            const split = line.indexOf('=')
            if (split > 0)
              (info[section] as Record<string, string>)[line.slice(0, split)] =
                line.slice(split + 1)
          } else if (line && section === 'requires')
            (info.requires as string[]).push(line)
        }
        result[ref.package!] = info
      }
    }
    res.json(result)
  })
  for (const path of [recipe, revision]) {
    app.get(`${path}/files`, async (req, res) => {
      const assets = await factory(res.locals.token).files(
        reference(req.params),
      )
      res.json({
        files: Object.fromEntries(
          assets
            .map((a) => originalName(a.name))
            .filter((name): name is string => Boolean(name))
            .map((name) => [name, {}]),
        ),
      })
    })
    app.get(`${path}/files/*filename`, async (req, res) => {
      const ref = reference(req.params)
      const name = filename(req.params.filename)
      const github = factory(res.locals.token)
      await github.file(ref, name)
      res.redirect(302, github.downloadUrl(ref, name))
    })
    app.put(`${path}/files/*filename`, async (req, res) => {
      await factory(res.locals.token).upload(
        reference(req.params),
        filename(req.params.filename),
        req,
      )
      res.status(201).send()
    })
    app.delete(path, async (req, res) => {
      await factory(res.locals.token).remove(reference(req.params))
      res.send()
    })
  }
  app.delete(`${recipe}/packages`, async (req, res) => {
    await factory(res.locals.token).remove(reference(req.params), true)
    res.send()
  })
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'))
  const errors: express.ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.code : 502
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (status === 401) res.set('WWW-Authenticate', 'Bearer')
    res
      .status(status)
      .type('text/plain')
      .send(error instanceof HttpError ? error.message : 'Request failed')
  }
  app.use(errors)
  return app
}
