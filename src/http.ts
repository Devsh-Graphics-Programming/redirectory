export class Error extends globalThis.Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

export function badRequest(message: string) {
  return new Error(400, message)
}

export function notFound(message: string) {
  return new Error(404, message)
}

export function badGateway(message: string) {
  return new Error(502, message)
}

export async function readText(stream: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > 1048576) throw new Error(413, 'Metadata too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJson(stream: AsyncIterable<Buffer>) {
  const text = await readText(stream)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(400, 'Invalid JSON')
  }
}
