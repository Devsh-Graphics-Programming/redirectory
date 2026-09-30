import * as http from '../http.js'
import { GitHub } from '../github.js'
import { reference } from '../model.js'
function serialize(recipe) {
  return (
    '<!--redirectory\n' +
    'Do not edit or remove this comment.\n' +
    JSON.stringify(recipe, null, 2) +
    '\n-->'
  )
}
function missing(level) {
  return http.notFound(`${level.type} missing: ${level.reference}`)
}
function sublevelRevision(level, id) {
  level = { ...level }
  if (id !== '0') {
    level.tag += '#' + id
    level.reference += '#' + id
  }
  return level
}
function sublevelPackage(level, id) {
  level = { ...level }
  level.type = 'Package'
  level.tag += '@' + id
  level.reference += ':' + id
  return level
}
export function getRecipeLevel(req) {
  const { name, version, user, channel } = req.params
  const reference = `${name}/${version}@${user}/${channel}`
  if (user !== 'github') {
    throw http.notFound(`Not a GitHub package: '${reference}'`)
  }
  return { type: 'Recipe', tag: version, reference }
}
export function getRecipeRevisionLevel(req) {
  const level = getRecipeLevel(req)
  return sublevelRevision(level, req.params.rrev)
}
export function getPackageLevel(req) {
  const level = getRecipeRevisionLevel(req)
  return sublevelPackage(level, req.params.package)
}
export function getPackageRevisionLevel(req) {
  const level = getPackageLevel(req)
  return sublevelRevision(level, req.params.prev)
}
export const Mode = { ReadOnly: 0, ReadWrite: 1, Create: 2 }
export async function getRecipe(req, mode = Mode.ReadOnly) {
  const client = Client.new(req, mode > Mode.ReadOnly)
  const level = getRecipeLevel(req)
  let release
  let value = {
    revisions: [{ id: '0', time: new Date().toISOString(), packages: [] }],
  }
  let prefix = '&nbsp;\n'
  let suffix = ''
  const found = await client.getReleaseByTag(level.tag).catch((error) => {
    if (error instanceof http.Error && error.code === 404) return undefined
    throw error
  })
  if (!found) {
    if (mode !== Mode.Create) {
      throw missing(level)
    }
    release = await client.createRelease(level.tag, {
      body: prefix + serialize(value),
    })
  } else {
    release = found
    release.assets = await client.assets(release)
    const body = release.body || prefix
    let match = body.match(
      /([\s\S]*)<!--\s*redirectory\s*([\s\S]*?)\s*-->([\s\S]*)/,
    )
    if (match) {
      prefix = match[1]
      suffix = match[3]
      let comment = match[2]
      comment = comment.substring(comment.indexOf('{'))
      try {
        value = parseJsonPrefix(comment)
      } catch (error) {
        throw http.badGateway(`Bad metadata comment: ${level.reference}`)
      }
    } else {
      prefix = body
      value = { revisions: [] }
    }
  }
  const root = { release, value, prefix, suffix }
  const db = { client, root }
  const $recipe = { level, value }
  return { db, $resource: $recipe }
}
export async function save({ client, root }) {
  const body = root.prefix + serialize(root.value) + root.suffix
  await client.updateRelease(root.release.id, { body })
}
function getChild(level, children, id, mode, child) {
  let index = children.findIndex((child) => child.id === id)
  if (index < 0) {
    if (mode !== Mode.Create) {
      throw missing(level)
    }
    index = children.length
    children.push(child)
  }
  const value = children[index]
  return { index, value }
}
export async function getRecipeRevision(req, mode = Mode.ReadOnly) {
  const { db, $resource: $recipe } = await getRecipe(req, mode)
  const id = req.params.rrev
  const level = sublevelRevision($recipe.level, id)
  const siblings = $recipe.value.revisions
  const { index, value } = getChild(level, siblings, id, mode, {
    id,
    time: new Date().toISOString(),
    packages: [],
  })
  const $rrev = { level, value, siblings, index }
  return { db, $resource: $rrev }
}
export function findPackage($rrev, id, mode = Mode.ReadOnly) {
  if (id === '0') {
    throw http.badRequest(`Invalid package ID: ${id}`)
  }
  const level = sublevelPackage($rrev.level, id)
  const siblings = $rrev.value.packages
  const { index, value } = getChild(level, siblings, id, mode, {
    id,
    revisions: [],
  })
  const $package = { level, value, siblings, index }
  return $package
}
export async function getLatestPackage(req) {
  const { db, $resource: $recipe } = await getRecipe(req)
  const $rrev = getLatestRevision($recipe)
  const id = req.params.package
  const $package = findPackage($rrev, id)
  return { db, $resource: $package }
}
export async function getPackage(req, mode = Mode.ReadOnly) {
  const { db, $resource: $rrev } = await getRecipeRevision(req, mode)
  const id = req.params.package
  const $package = findPackage($rrev, id, mode)
  return { db, $resource: $package }
}
export async function getPackageRevision(req, mode = Mode.ReadOnly) {
  const { db, $resource: $package } = await getPackage(req, mode)
  const id = req.params.prev
  const level = sublevelRevision($package.level, id)
  const siblings = $package.value.revisions
  const { index, value } = getChild(level, siblings, id, mode, {
    id,
    time: new Date().toISOString(),
  })
  const $prev = { level, value, siblings, index }
  return { db, $resource: $prev }
}
export function getLatestRevision($revisible) {
  const siblings = $revisible.value.revisions
  if (siblings.length === 0) {
    throw missing($revisible.level)
  }
  const value = siblings.reduce((latest, revision) =>
    revision.time > latest.time ? revision : latest,
  )
  const index = siblings.indexOf(value)
  const level = sublevelRevision($revisible.level, value.id)
  return { level, value, siblings, index }
}
export function getRevisions($revisible) {
  const siblings = $revisible.value.revisions
  if (siblings.length === 0) {
    throw missing($revisible.level)
  }
  return siblings.map(({ id, time }) => ({
    revision: id,
    time,
  }))
}
export async function getRelease(db, $revision, mode = Mode.ReadOnly) {
  let release = $revision.value.release
  if (!release) {
    let data
    if ($revision.value.id === '0' && $revision.level.type === 'Recipe') {
      data = db.root.release
    } else if (mode !== Mode.Create) {
      throw http.notFound(`Missing release: ${$revision.level.reference}`)
    } else {
      data = await db.client
        .createRelease($revision.level.tag)
        .catch((error) => {
          if (error instanceof http.Error && error.code === 422)
            return db.client.getReleaseByTag($revision.level.tag)
          throw error
        })
    }
    release = {
      id: data.id,
      origin: new URL(data.upload_url).origin,
      assets: {},
    }
    $revision.value.release = release
  }
  return release
}
export function getFile(repo, level, filename) {
  return `https://github.com/${repo.owner}/${repo.name}/releases/download/${encodeURIComponent(level.tag)}/${filename}`
}
export async function putFile(db, release, req) {
  const result = await db.client.upload(release, req)
  const level = req.params.package
    ? getPackageRevisionLevel(req)
    : getRecipeRevisionLevel(req)
  return {
    name: req.params.filename,
    md5: result.md5,
    browser_download_url: getFile(
      { owner: db.client.owner, name: db.client.repo },
      level,
      req.params.filename,
    ),
  }
}
export async function deleteRevision(db, revision) {
  const release = revision.release
  if (!release) {
    return
  }
  await db.client.deleteRelease(release.id)
}
export function deletePackage(db, $package) {
  return $package.revisions.flatMap(($prev) => deleteRevision(db, $prev))
}
export function deletePackages(db, $rrev) {
  return $rrev.packages.flatMap(($package) => deletePackage(db, $package))
}
export function deleteRecipeRevision(db, $rrev) {
  const promises = deletePackages(db, $rrev)
  const release = $rrev.release
  if (release) {
    if ($rrev.id === '0') {
      for (const asset of db.root.release.assets) {
        promises.push(db.client.deleteAsset(asset.id))
      }
    } else {
      promises.push(db.client.deleteRelease(release.id))
    }
  }
  return promises
}
export function deleteRecipe(db, $recipe) {
  return $recipe.revisions.flatMap(($rrev) => deleteRecipeRevision(db, $rrev))
}

function parseJsonPrefix(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    const match = error.message.match(/position\s+(\d+)/)
    if (!match) {
      throw error
    }
    text = text.substr(0, match[1])
  }
  return JSON.parse(text)
}

export function parseRepository(req) {
  const ref = reference(req.params)
  if (ref.user !== 'github') throw http.notFound('Not a GitHub package')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(ref.channel))
    throw http.badRequest('Invalid repository owner')
  return { owner: ref.channel, name: ref.name }
}

export class Client extends GitHub {
  assetName = (name) => name
  constructor(req, owner, repo) {
    const { config, transport, api, uploads } = req.redirectory
    super(
      { ...config, repository: owner ? owner + '/' + repo : '' },
      req.credentials?.token || config.readToken,
      transport,
      api,
      uploads,
    )
    this.owner = owner
    this.repo = repo
  }
  static new(req, write = false) {
    if (write && !req.credentials)
      throw new http.Error(401, 'Authentication required')
    const { owner, name } = parseRepository(req)
    return new Client(req, owner, name)
  }
  async json(path, method = 'GET', body) {
    const response = await this.request(path, {
      method,
      ...(body
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    })
    return response.status === 204 ? null : response.json()
  }
  getReleaseByTag(tag) {
    return this.json(this.base + '/releases/tags/' + encodeURIComponent(tag))
  }
  createRelease(tag, parameters = {}) {
    return this.json(this.base + '/releases', 'POST', {
      tag_name: tag,
      make_latest: 'false',
      ...parameters,
    })
  }
  updateRelease(id, body) {
    return this.json(this.base + '/releases/' + id, 'PATCH', body)
  }
  deleteRelease(id) {
    return this.json(this.base + '/releases/' + id, 'DELETE')
  }
  deleteAsset(id) {
    return this.json(this.base + '/releases/assets/' + id, 'DELETE')
  }
  async upload(release, req) {
    return this.uploadAsset(
      release,
      req.params.filename,
      req,
      await this.prepareUpload(req),
    )
  }
}

export async function searchRepositories(req, query) {
  return (
    await new Client(req).json(
      '/search/repositories?' + new URLSearchParams(query),
    )
  ).items
}

export async function listReleases(req, owner, repo) {
  const client = new Client(req, owner, repo)
  const releases = await client.json(
    client.base + '/releases?per_page=100&page=1',
  )
  for (const release of releases) release.assets = await client.assets(release)
  return releases
}
