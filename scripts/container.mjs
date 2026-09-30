import { createServer } from 'node:http'

if (process.argv[2] === '--bootstrap') {
  createServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain' })
    response.end('Deployment pending')
  }).listen(Number(process.env.PORT), '0.0.0.0')
} else {
  const url =
    process.argv[2] || `http://127.0.0.1:${process.env.PORT || 9595}/healthz`

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
    process.exitCode =
      response.ok && (await response.json()).status === 'ok' ? 0 : 1
  } catch {
    process.exitCode = 1
  }
}
