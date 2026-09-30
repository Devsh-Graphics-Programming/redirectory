import express from 'express'
import { basic, bearer, issue, grant, checkGrant } from '../auth.js'
import { Error as HttpError, readJson } from '../http.js'
import { filename, reference } from '../model.js'
import * as model from './model.js'

export function createLegacyRouter(config, options = {}) {
  const router = express.Router()
  router.get('/', (_req, res) =>
    res.redirect(301, 'https://github.com/thejohnfreeman/redirectory'),
  )
  const locks = new Map()
  const serial = (handler) => async (req, res) => {
    const key = [req.params.channel, req.params.name, req.params.version].join(
      '/',
    )
    const prior = locks.get(key) || Promise.resolve()
    let unlock
    const current = new Promise((resolve) => {
      unlock = resolve
    })
    locks.set(key, current)
    await prior
    try {
      await handler(req, res)
    } finally {
      unlock()
      if (locks.get(key) === current) locks.delete(key)
    }
  }
  router.use((req, res, next) => {
    req.redirectory = {
      config,
      transport: options.transport || fetch,
      api: options.api || 'https://api.github.com',
      uploads: options.uploads || 'https://uploads.github.com',
      downloadUrl: options.downloadUrl,
    }
    next()
  })
  for (const api of ['v1', 'v2']) {
    router.get('/' + api + '/ping', (_req, res) =>
      res.set('X-Conan-Server-Capabilities', 'complex_search,revisions').send(),
    )
    router.get('/' + api + '/users/authenticate', async (req, res) => {
      req.credentials = basic(req.get('Authorization'))
      await new model.Client(req).json('/user')
      res.type('text/plain').send(issue(config, req.credentials))
    })
    router.get('/' + api + '/users/check_credentials', async (req, res) => {
      req.credentials = bearer(config, req.get('Authorization'))
      await new model.Client(req).json('/user')
      res.type('text/plain').send(req.credentials.user)
    })
  }
  router.use((req, res, next) => {
    if (req.path.startsWith('/v1/files/') || req.path.startsWith('/v2/files/'))
      req.credentials = checkGrant(config, req)
    else if (req.get('Authorization'))
      req.credentials = bearer(config, req.get('Authorization'))
    else if (!config.anonymousRead || !['GET', 'HEAD'].includes(req.method))
      throw new HttpError(401, 'Authentication required')
    next()
  })
  router.param('filename', (req, _res, next, value) => {
    filename(value)
    next()
  })
  for (const api of ['v1', 'v2']) {
    const recipe = `/${api}/conans/:name/:version/:user/:channel`
    const revision = recipe + '/revisions/:rrev'
    const binary = revision + '/packages/:package'
    const previous = binary + '/revisions/:prev'
    const binary1 = recipe + '/packages/:package'
    const file = `/${api}/files/:name/:version/:user/:channel/:rrev`
    for (const path of [recipe, file])
      router.use(path, async (req, _res, next) => {
        reference(req.params)
        await model.Client.new(
          req,
          !['GET', 'HEAD'].includes(req.method),
        ).authorize(!['GET', 'HEAD'].includes(req.method))
        next()
      })
    const get = (path, handler) => router.get(path, handler)
    const put = (path, handler) => router.put(path, serial(handler))
    const post = (path, handler) => router.post(path, serial(handler))
    const del = (path, handler) => router.delete(path, serial(handler))
    get('/' + api + '/conans/search', getSearch)
    del(recipe, deleteRecipe)
    get(recipe + '/latest', getLatest(model.getRecipe))
    get(recipe + '/revisions', getRevisions(model.getRecipe))
    get(recipe + '/search', getRecipeSearch)
    del(revision, deleteRecipeRevision)
    get(revision + '/files', getFiles(model.getRecipeRevision))
    get(revision + '/files/:filename', getFile(model.getRecipeRevisionLevel))
    put(revision + '/files/:filename', putRevisionFile(model.getRecipeRevision))
    del(revision + '/packages', deleteRecipeRevisionPackages)
    get(revision + '/search', getRecipeRevisionSearch)
    get(binary + '/latest', getLatest(model.getPackage))
    get(binary + '/revisions', getRevisions(model.getPackage))
    del(previous, deletePackageRevision)
    get(previous + '/files', getFiles(model.getPackageRevision))
    get(previous + '/files/:filename', getFile(model.getPackageRevisionLevel))
    put(
      previous + '/files/:filename',
      putRevisionFile(model.getPackageRevision),
    )
    get(recipe, getFileSums(model.getRecipe))
    get(recipe + '/digest', getDownloadUrls(model.getRecipe))
    get(recipe + '/download_urls', getDownloadUrls(model.getRecipe))
    post(
      recipe + '/upload_urls',
      postUploadUrls(() => 'export'),
    )
    put(file + '/export/:filename', putRevisionFile(model.getRecipeRevision))
    post(recipe + '/packages/delete', postRecipePackagesDelete)
    get(binary1, getFileSums(model.getLatestPackage))
    get(binary1 + '/digest', getDownloadUrls(model.getLatestPackage))
    get(binary1 + '/download_urls', getDownloadUrls(model.getLatestPackage))
    post(
      binary1 + '/upload_urls',
      postUploadUrls((req) => `package/${req.params.package}/0`),
    )
    put(
      file + '/package/:package/:prev/:filename',
      putRevisionFile(model.getPackageRevision),
    )
  }
  router.use((_req, res) =>
    res.status(501).type('text/plain').send('Not implemented'),
  )
  return router
}

function mapObject(object, fn) {
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, fn(v)]))
}
const getLatest = (getRevisible) => async (req, res) => {
  const { $resource: $revisible } = await getRevisible(req)
  const $rev = model.getLatestRevision($revisible)
  const { id, time } = $rev.value
  res.send({ revision: id, time })
}
const getRevisions = (getRevisible) => async (req, res) => {
  const { $resource: $revisible } = await getRevisible(req)
  const revisions = model.getRevisions($revisible)
  res.send({ revisions })
}
const getFile = (getLevel) => (req, res) => {
  const repo = model.parseRepository(req)
  const level = getLevel(req)
  const url = (req.redirectory.downloadUrl || model.getFile)(
    repo,
    level,
    req.params.filename,
  )
  return res.redirect(301, url)
}
const getFiles = (getRevision) => async (req, res) => {
  const { db, $resource: $rev } = await getRevision(req)
  const release = await model.getRelease(db, $rev)
  const assets = release.assets
  const files = mapObject(assets, () => ({}))
  return res.send({ files })
}
const getFileSums = (getRevisible) => async (req, res) => {
  const { db, $resource: $revisible } = await getRevisible(req)
  const $rev = model.getLatestRevision($revisible)
  const release = await model.getRelease(db, $rev)
  const assets = release.assets
  const body = mapObject(assets, ({ md5 }) => md5)
  return res.send(body)
}
const getDownloadUrls = (getRevisible) => async (req, res) => {
  const { db, $resource: $revisible } = await getRevisible(req)
  const $rev = model.getLatestRevision($revisible)
  const release = await model.getRelease(db, $rev)
  const assets = release.assets
  const repo = model.parseRepository(req)
  const body = Object.fromEntries(
    Object.keys(assets).map((name) => {
      const url = new URL(
        (req.redirectory.downloadUrl || model.getFile)(repo, $rev.level, name),
      )
      url.searchParams.set('signature', 'public')
      return [name, url.href]
    }),
  )
  return res.send(body)
}
const postUploadUrls = (uploadPath) => async (req, res) => {
  model.getRecipeLevel(req)
  const { name, version, user, channel } = req.params
  const files = await readJson(req)
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new HttpError(400, 'Invalid upload request')
  const result = Object.create(null)
  const config = req.redirectory.config
  const origin = config.publicUrl || `${req.protocol}://${req.get('Host')}`
  const url = new URL(origin)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new HttpError(400, 'Invalid public URL')
  for (const [nameOfFile, size] of Object.entries(files)) {
    filename(nameOfFile)
    if (!Number.isSafeInteger(size) || size < 0 || size > config.maxUploadBytes)
      throw new HttpError(413, 'Invalid upload size')
    const path = `/v1/files/${name}/${version}/${user}/${channel}/0/${uploadPath(req)}/${nameOfFile}`
    result[nameOfFile] =
      url.origin +
      path +
      '?signature=' +
      grant(config, req.credentials, path, size)
  }
  res.json(result)
}
const putRevisionFile = (getRevision) => async (req, res) => {
  const mode = model.Mode.Create
  const { db, $resource: $rev } = await getRevision(req, mode)
  const release = await model.getRelease(db, $rev, mode)
  const data = await model.putFile(db, release, req)
  release.assets = {
    ...release.assets,
    [data.name]: {
      md5: data.md5,
      url: data.browser_download_url,
    },
  }
  await model.save(db)
  return res.status(201).send()
}

async function deleteRecipe(req, res) {
  const mode = model.Mode.ReadWrite
  const { db, $resource: $recipe } = await model.getRecipe(req, mode)
  await Promise.all(model.deleteRecipe(db, $recipe.value))
  $recipe.value.revisions = []
  await model.save(db)
  return res.send()
}

async function deleteRecipeRevision(req, res) {
  const mode = model.Mode.ReadWrite
  const { db, $resource: $rrev } = await model.getRecipeRevision(req, mode)
  await Promise.all(model.deleteRecipeRevision(db, $rrev.value))
  $rrev.siblings.splice($rrev.index, 1)
  await model.save(db)
  return res.send()
}

async function deleteRecipeRevisionPackages(req, res) {
  const mode = model.Mode.ReadWrite
  const { db, $resource: $rrev } = await model.getRecipeRevision(req, mode)
  await Promise.all(model.deletePackages(db, $rrev.value))
  $rrev.value.packages = []
  await model.save(db)
  return res.send()
}

async function deletePackageRevision(req, res) {
  const mode = model.Mode.ReadWrite
  const { db, $resource: $prev } = await model.getPackageRevision(req, mode)
  await model.deleteRevision(db, $prev.value)
  $prev.siblings.splice($prev.index, 1)
  await model.save(db)
  return res.send()
}

async function postRecipePackagesDelete(req, res) {
  const mode = model.Mode.ReadWrite
  const { db, $resource: $recipe } = await model.getRecipe(req, mode)
  const $rrev = model.getLatestRevision($recipe)
  const { package_ids } = await readJson(req)
  if (package_ids.length === 0) {
    await Promise.all(model.deletePackages(db, $rrev.value))
    $rrev.value.packages = []
  } else {
    const promises = package_ids.flatMap((id) => {
      const $package = model.findPackage($rrev, id)
      $package.siblings.splice($package.index, 1)
      return model.deletePackage(db, $package.value)
    })
    await Promise.all(promises)
  }
  await model.save(db)
  return res.send()
}
function getRecipeSearch(req, res) {
  return res.status(501).send()
}
async function getRecipeRevisionSearch(req, res) {
  const { db, $resource: $rrev } = await model.getRecipeRevision(req)
  const entries = $rrev.value.packages.map(($package) => [
    $package.id,
    { content: '' },
  ])
  res.send(Object.fromEntries(entries))
}
const PATTERN_SEARCH_QUERY = /^([^/#@]+)(?:\/([^/#@]+)@?)?$/
const PATTERN_TAG_RECIPE = /^([^/#@]+)(?:#[a-zA-Z0-9]{1,51})?$/
async function getSearch(req, res) {
  const query = req.query.q
  const results = []
  let m = PATTERN_SEARCH_QUERY.exec(query)
  if (!m) {
    return res.send({ results })
  }
  const nameGlob = m[1]
  const versionGlob = m[2]
  const nameSubstring = nameGlob.split('*').filter((x) => x)[0]
  if (!nameSubstring) {
    return res.send({ results })
  }
  const repositories = await model.searchRepositories(req, {
    q: `${nameSubstring} in:name topic:redirectory`,
    sort: 'stars',
    order: 'desc',
  })
  const nameRegex = new RegExp(
    '^' + nameGlob.split('*').map(escapeRegExp).join('.*') + '$',
  )
  for (const result of repositories) {
    const repo = result.name
    if (!nameRegex.exec(repo)) {
      continue
    }
    const owner = result.owner.login
    const releases = await model.listReleases(req, owner, repo)
    for (const release of releases) {
      const tag = release.tag_name
      let m = PATTERN_TAG_RECIPE.exec(tag)
      if (!m) {
        continue
      }
      const version = m[1]
      if (versionGlob) {
        const versionRegex = new RegExp(
          '^' + versionGlob.split('*').map(escapeRegExp).join('.*') + '$',
        )
        if (!versionRegex.exec(version)) {
          continue
        }
      }
      if (!release.assets.map((a) => a.name).includes('conanmanifest.txt')) {
        continue
      }
      results.push(`${repo}/${version}@github/${owner}`)
    }
  }
  return res.send({ results })
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
