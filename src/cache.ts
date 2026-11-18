interface Snapshot {
  status: number
  headers: [string, string][]
  body: Uint8Array
}

export class MetadataCache {
  private entries = new Map<string, { value: Snapshot; expires: number }>()
  private pending = new Map<string, Promise<Snapshot>>()
  private bytes = 0
  private generation = 0

  constructor(
    private now = Date.now,
    private ttl = 30000,
    private maxEntries = 512,
    private maxBytes = 16 * 1024 * 1024,
  ) {}

  clear() {
    this.generation++
    this.entries.clear()
    this.pending.clear()
    this.bytes = 0
  }

  invalidate(matches: (key: string) => boolean) {
    for (const [key, entry] of this.entries) {
      if (!matches(key)) continue
      this.bytes -= entry.value.body.byteLength
      this.entries.delete(key)
    }
    for (const key of this.pending.keys())
      if (matches(key)) this.pending.delete(key)
  }

  async get(key: string, load: () => Promise<Response>): Promise<Response> {
    const cached = this.entries.get(key)
    if (cached && cached.expires > this.now())
      return this.response(cached.value)
    if (cached) {
      this.bytes -= cached.value.body.byteLength
      this.entries.delete(key)
    }
    let pending = this.pending.get(key)
    if (!pending) {
      if (this.pending.size >= this.maxEntries) return load()
      const generation = this.generation
      pending = (async () => {
        const response = await load()
        const value: Snapshot = {
          status: response.status,
          headers: [...response.headers],
          body: new Uint8Array(await response.arrayBuffer()),
        }
        if (
          generation === this.generation &&
          this.pending.get(key) === pending &&
          (response.ok || response.status === 404) &&
          value.body.byteLength <= this.maxBytes
        ) {
          while (
            this.entries.size >= this.maxEntries ||
            this.bytes + value.body.byteLength > this.maxBytes
          ) {
            const first = this.entries.keys().next().value!
            this.bytes -= this.entries.get(first)!.value.body.byteLength
            this.entries.delete(first)
          }
          this.entries.set(key, {
            value,
            expires:
              this.now() +
              (response.status === 404 ? Math.min(this.ttl, 5000) : this.ttl),
          })
          this.bytes += value.body.byteLength
        }
        return value
      })()
      this.pending.set(key, pending)
      void pending
        .finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key)
        })
        .catch(() => {})
    }
    return this.response(await pending)
  }

  private response(value: Snapshot) {
    return new Response(value.body.slice(), {
      status: value.status,
      headers: value.headers,
    })
  }
}
