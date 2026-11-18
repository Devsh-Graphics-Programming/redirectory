import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import type { Request } from 'express'
import type { Config } from './config.js'
import { Error as HttpError, readText } from './http.js'
import { MetadataCache } from './cache.js'
import {
  assetName,
  display,
  emptyAssetName,
  emptyOriginalName,
  matches,
  reference,
  tag,
  type Reference,
} from './model.js'

const emptySha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
const emptySha256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const emptyMarker = Buffer.from('redirectory-empty-file-v1')
const emptyMarkerDigest =
  'sha256:' + createHash('sha256').update(emptyMarker).digest('hex')

export interface Asset {
  id: number
  name: string
  size: number
  state: string
  digest?: string
  browser_download_url: string
  created_at: string
  empty?: boolean
}
export interface Release {
  id: number
  tag_name: string
  body: string
  created_at: string
  published_at?: string
  assets: Asset[]
  draft?: boolean
  ref?: Reference
}
export type Fetch = typeof fetch

export class GitHub {
  protected assetName = assetName
  protected emptyAssetName = emptyAssetName
  protected base: string
  constructor(
    private config: Config,
    private token?: string,
    private transport: Fetch = fetch,
    private api = 'https://api.github.com',
    private uploads = 'https://uploads.github.com',
    private options: {
      cache?: MetadataCache
      log?: (line: string) => void
    } = {},
  ) {
    this.base = `/repos/${config.repository}`
  }

  protected async request(
    path: string,
    init: RequestInit = {},
    origin = this.api,
    cache = true,
    affectedTag?: string,
  ): Promise<Response> {
    const method = init.method || 'GET'
    const read = method === 'GET'
    const load = async () => {
      const response = await this.transport(origin + path, {
        ...init,
        redirect: 'error',
        signal:
          init.signal || AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'redirectory',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
      })
      const number = (name: string) => {
        const value = response.headers.get(name)
        return value !== null && /^\d{1,12}$/.test(value)
          ? Number(value)
          : undefined
      }
      const requestId = response.headers.get('x-github-request-id')
      const resource = response.headers.get('x-ratelimit-resource')
      const remaining = number('x-ratelimit-remaining')
      const retry = number('retry-after')
      const limited =
        response.status === 429 ||
        (response.status === 403 && (remaining === 0 || retry !== undefined))
      this.options.log?.(
        JSON.stringify({
          event: 'github_request',
          operation:
            origin === this.uploads
              ? 'upload'
              : path === this.base
                ? 'repository'
                : path.includes('/assets')
                  ? 'assets'
                  : path.includes('/releases')
                    ? 'releases'
                    : 'tags',
          method,
          status: response.status,
          rate_limited: limited,
          rate_limit: number('x-ratelimit-limit'),
          rate_remaining: remaining,
          rate_used: number('x-ratelimit-used'),
          rate_reset: number('x-ratelimit-reset'),
          rate_resource:
            resource &&
            [
              'core',
              'search',
              'code_search',
              'graphql',
              'integration_manifest',
            ].includes(resource)
              ? resource
              : undefined,
          retry_after: retry,
          request_id:
            requestId && /^[A-Za-z0-9:-]{1,100}$/.test(requestId)
              ? requestId
              : undefined,
        }),
      )
      return response
    }
    const invalidate = () => {
      const releases = this.api + this.base + '/releases'
      const id = path.match(/\/releases\/(\d+)(?:\/|$)/)?.[1]
      this.options.cache?.invalidate(
        (key) =>
          key.includes(releases + '?') ||
          key.endsWith(releases + '/tags/' + affectedTag) ||
          (id !== undefined && key.includes(releases + '/' + id + '/assets?')),
      )
    }
    if (!read) invalidate()
    let response: Response
    try {
      response =
        read && cache && this.options.cache
          ? await this.options.cache.get(
              createHash('sha256')
                .update(this.token || '')
                .digest('hex') +
                ':' +
                origin +
                path,
              load,
            )
          : await load()
    } finally {
      if (!read) invalidate()
    }
    if (!response.ok) {
      await response.body?.cancel()
      const remaining = response.headers.get('x-ratelimit-remaining')
      const retry = response.headers.get('retry-after')
      const retrySeconds =
        retry !== null && /^\d{1,12}$/.test(retry) ? Number(retry) : undefined
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (remaining === '0' || retrySeconds !== undefined))
      ) {
        const reset = Number(response.headers.get('x-ratelimit-reset'))
        const seconds =
          retrySeconds !== undefined
            ? retrySeconds
            : Number.isSafeInteger(reset) && reset > 0
              ? Math.max(1, reset - Math.floor(Date.now() / 1000))
              : undefined
        throw new HttpError(
          429,
          'GitHub API rate limit exceeded. Retry later',
          seconds,
        )
      }
      const status = [401, 403, 404, 409, 422, 429].includes(response.status)
        ? response.status
        : 502
      throw new HttpError(
        status,
        status === 404
          ? 'Package or repository not found'
          : 'GitHub request failed',
      )
    }
    return response
  }

  async authorize(write = false, fresh = false) {
    const repository = await (
      await this.request(this.base, {}, this.api, !fresh)
    ).json()
    if (repository.private)
      throw new HttpError(403, 'Only public package repositories are supported')
    if (write && !this.token)
      throw new HttpError(403, 'Repository write permission required')
  }

  async release(ref: Reference, create = false): Promise<Release> {
    const releaseTag = tag(ref)
    try {
      return await (
        await this.request(`${this.base}/releases/tags/${releaseTag}`)
      ).json()
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 404 || !create)
        throw error
    }
    try {
      return await (
        await this.request(
          `${this.base}/releases`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tag_name: releaseTag,
              name: `${display(ref)}#${ref.rrev}${ref.package ? ':' + ref.package + '#' + ref.prev : ''}`,
              body: JSON.stringify({
                format: 'redirectory-v1',
                reference: ref,
              }),
              make_latest: 'false',
            }),
          },
          this.api,
          true,
          releaseTag,
        )
      ).json()
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 422) throw error
      return this.release(ref)
    }
  }

  async assets(release: Release, fresh = false): Promise<Asset[]> {
    if (!fresh && Array.isArray(release.assets) && release.assets.length < 100)
      return release.assets.filter((asset) => asset.state === 'uploaded')
    const result: Asset[] = []
    for (let page = 1; ; page++) {
      const batch: Asset[] = await (
        await this.request(
          `${this.base}/releases/${release.id}/assets?per_page=100&page=${page}`,
          {},
          this.api,
          !fresh,
        )
      ).json()
      result.push(...batch)
      if (batch.length < 100)
        return result.filter((asset) => asset.state === 'uploaded')
    }
  }

  async list(
    prefix?: Reference,
    includeIncomplete = false,
    accept?: (ref: Reference) => boolean,
  ): Promise<Release[]> {
    const result: Release[] = []
    for (let page = 1; ; page++) {
      const batch: Release[] = await (
        await this.request(`${this.base}/releases?per_page=100&page=${page}`)
      ).json()
      for (const release of batch) {
        if (release.draft || !release.tag_name.startsWith('rd-v1-')) continue
        let ref: Reference
        try {
          const metadata = JSON.parse(release.body)
          ref = reference(metadata.reference)
          if (
            metadata.format !== 'redirectory-v1' ||
            !ref.rrev ||
            tag(ref) !== release.tag_name ||
            (prefix && !matches(ref, prefix)) ||
            (accept && !accept(ref))
          )
            continue
        } catch {
          continue
        }
        if (!includeIncomplete) release.assets = await this.assets(release)
        if (
          !includeIncomplete &&
          !release.assets.some(
            (asset) =>
              asset.name === this.assetName('conanmanifest.txt') &&
              asset.state === 'uploaded',
          )
        )
          continue
        result.push({ ...release, ref })
      }
      if (batch.length < 100)
        return result.sort(
          (a, b) =>
            (b.published_at || b.created_at).localeCompare(
              a.published_at || a.created_at,
            ) || b.id - a.id,
        )
    }
  }

  async files(ref: Reference) {
    const assets = await this.assets(await this.release(ref))
    if (
      !assets.some(
        (asset) => asset.name === this.assetName('conanmanifest.txt'),
      )
    )
      throw new HttpError(404, 'Revision upload is incomplete')
    return assets.map((asset) => {
      const name = emptyOriginalName(asset.name)
      return name
        ? {
            ...asset,
            name: this.assetName(name),
            size: 0,
            digest: 'sha256:' + emptySha256,
            empty: true,
          }
        : asset
    })
  }

  async file(ref: Reference, name: string): Promise<Asset> {
    const asset = (await this.files(ref)).find(
      (asset) => asset.name === this.assetName(name),
    )
    if (!asset) throw new HttpError(404, 'File not found')
    return asset
  }

  downloadUrl(ref: Reference, name: string) {
    return `https://github.com/${this.config.repository}/releases/download/${tag(ref)}/${this.assetName(name)}`
  }

  async content(ref: Reference, name: string): Promise<string> {
    const asset = await this.file(ref, name)
    if (asset.empty) return ''
    if (asset.size > 1048576) throw new HttpError(413, 'Metadata too large')
    const response = await this.transport(this.downloadUrl(ref, name), {
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok || !response.body)
      throw new HttpError(502, 'Metadata unavailable')
    return readText(Readable.fromWeb(response.body as never))
  }

  async upload(ref: Reference, name: string, req: Request) {
    const size = await this.prepareUpload(req)
    const release = await this.release(ref, true)
    return this.uploadAsset(release, name, req, size)
  }

  protected async prepareUpload(req: Request) {
    const length = req.get('Content-Length')
    let size: number
    if (length === undefined) {
      if (req.get('X-Checksum-Sha1') !== emptySha1)
        throw new HttpError(411, 'Content-Length required')
      size = 0
    } else {
      if (!/^\d+$/.test(length))
        throw new HttpError(411, 'Content-Length required')
      size = Number(length)
    }
    if (!Number.isSafeInteger(size) || size > this.config.maxUploadBytes)
      throw new HttpError(413, 'Upload too large')
    await this.authorize(true)
    return size
  }

  protected async uploadAsset(
    release: Release,
    name: string,
    req: Request,
    size: number,
  ) {
    const empty = size === 0
    const storedName = empty ? this.emptyAssetName(name) : this.assetName(name)
    const conflictingName = empty
      ? this.assetName(name)
      : this.emptyAssetName(name)
    const assets = await this.assets(release)
    const existing = assets.find((asset) => asset.name === storedName)
    const conflicting = assets.find((asset) => asset.name === conflictingName)
    const storedSize = empty ? emptyMarker.length : size
    const hash = createHash('sha256')
    const md5 = createHash('md5')
    let received = 0
    const body = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > size)
          return callback(new HttpError(400, 'Upload size mismatch'))
        hash.update(chunk)
        md5.update(chunk)
        callback(null, chunk)
      },
      flush(callback) {
        callback(
          received === size
            ? undefined
            : new HttpError(400, 'Upload size mismatch'),
        )
      },
    })
    const abort = new AbortController()
    const onAbort = () => {
      abort.abort()
      body.destroy()
    }
    req.once('aborted', onAbort)
    req.once('error', onAbort)
    req.pipe(body)
    try {
      if (existing || conflicting || empty) {
        for await (const _chunk of body) {
        }
      }
      if (conflicting)
        throw new HttpError(409, 'Revision already contains a different file')
      if (existing) {
        const digest = empty
          ? emptyMarkerDigest
          : 'sha256:' + hash.digest('hex')
        if (existing.size !== storedSize || existing.digest !== digest)
          throw new HttpError(409, 'Revision already contains a different file')
        return { md5: md5.digest('hex') }
      }
      try {
        await (
          await this.request(
            `${this.base}/releases/${release.id}/assets?name=${storedName}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(storedSize),
              },
              body: (empty ? emptyMarker : body) as unknown as BodyInit,
              duplex: 'half',
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(this.config.requestTimeoutMs),
              ]),
            } as RequestInit,
            this.uploads,
            true,
            release.tag_name,
          )
        ).body?.cancel()
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== 422 ||
          !body.readableEnded
        )
          throw error
        const raced = (await this.assets(release, true)).find(
          (asset) => asset.name === storedName,
        )
        const digest = empty
          ? emptyMarkerDigest
          : 'sha256:' + hash.digest('hex')
        if (raced?.size !== storedSize || raced.digest !== digest)
          throw new HttpError(409, 'Concurrent upload conflict. Try again')
      }
      return { md5: md5.digest('hex') }
    } finally {
      req.removeListener('aborted', onAbort)
      req.removeListener('error', onAbort)
      req.unpipe(body)
      body.destroy()
    }
  }

  async remove(prefix: Reference, packagesOnly = false) {
    await this.authorize(true)
    const releases = (await this.list(prefix, true)).filter(
      (release) => !packagesOnly || release.ref?.package,
    )
    if (!releases.length) throw new HttpError(404, 'Package not found')
    for (const release of releases) {
      try {
        await this.request(
          `${this.base}/git/refs/tags/${release.tag_name}`,
          {
            method: 'DELETE',
          },
          this.api,
          true,
          release.tag_name,
        )
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 404) throw error
      }
      await this.request(
        `${this.base}/releases/${release.id}`,
        {
          method: 'DELETE',
        },
        this.api,
        true,
        release.tag_name,
      )
    }
  }
}
