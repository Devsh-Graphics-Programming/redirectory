import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import type { Request } from 'express'
import type { Config } from './config.js'
import { Error as HttpError, readText } from './http.js'
import {
  assetName,
  display,
  matches,
  reference,
  tag,
  type Reference,
} from './model.js'

export interface Asset {
  id: number
  name: string
  size: number
  state: string
  digest?: string
  browser_download_url: string
  created_at: string
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
  protected base: string
  constructor(
    private config: Config,
    private token?: string,
    private transport: Fetch = fetch,
    private api = 'https://api.github.com',
    private uploads = 'https://uploads.github.com',
  ) {
    this.base = `/repos/${config.repository}`
  }

  protected async request(
    path: string,
    init: RequestInit = {},
    origin = this.api,
  ): Promise<Response> {
    const response = await this.transport(origin + path, {
      ...init,
      redirect: 'error',
      signal: init.signal || AbortSignal.timeout(this.config.requestTimeoutMs),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'redirectory',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) {
      await response.body?.cancel()
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

  async authorize(write = false) {
    const repository = await (await this.request(this.base)).json()
    if (repository.private)
      throw new HttpError(403, 'Only public package repositories are supported')
    if (write && repository.permissions?.push !== true)
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
        await this.request(`${this.base}/releases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag_name: releaseTag,
            name: `${display(ref)}#${ref.rrev}${ref.package ? ':' + ref.package + '#' + ref.prev : ''}`,
            body: JSON.stringify({ format: 'redirectory-v1', reference: ref }),
            make_latest: 'false',
          }),
        })
      ).json()
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 422) throw error
      return this.release(ref)
    }
  }

  async assets(release: Release): Promise<Asset[]> {
    const result: Asset[] = []
    for (let page = 1; ; page++) {
      const batch: Asset[] = await (
        await this.request(
          `${this.base}/releases/${release.id}/assets?per_page=100&page=${page}`,
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
            (prefix && !matches(ref, prefix))
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
    return assets
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
    if (!length || !/^\d+$/.test(length))
      throw new HttpError(411, 'Content-Length required')
    const size = Number(length)
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
    const existing = (await this.assets(release)).find(
      (asset) => asset.name === this.assetName(name),
    )
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
      if (existing) {
        for await (const _chunk of body) {
        }
        if (
          existing.size !== size ||
          existing.digest !== 'sha256:' + hash.digest('hex')
        )
          throw new HttpError(409, 'Revision already contains a different file')
        return { md5: md5.digest('hex') }
      }
      try {
        await (
          await this.request(
            `${this.base}/releases/${release.id}/assets?name=${this.assetName(name)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(size),
              },
              body: body as unknown as BodyInit,
              duplex: 'half',
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(this.config.requestTimeoutMs),
              ]),
            } as RequestInit,
            this.uploads,
          )
        ).body?.cancel()
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== 422 ||
          !body.readableEnded
        )
          throw error
        const raced = (await this.assets(release)).find(
          (asset) => asset.name === this.assetName(name),
        )
        if (
          raced?.size !== size ||
          raced.digest !== 'sha256:' + hash.digest('hex')
        )
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
        await this.request(`${this.base}/git/refs/tags/${release.tag_name}`, {
          method: 'DELETE',
        })
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 404) throw error
      }
      await this.request(`${this.base}/releases/${release.id}`, {
        method: 'DELETE',
      })
    }
  }
}
