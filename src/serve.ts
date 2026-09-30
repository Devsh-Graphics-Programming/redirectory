import { configuration } from './config.js'
import { createApp } from './router.js'

try {
  const config = configuration()
  const server = createApp(config).listen(config.port, '0.0.0.0', () =>
    console.log(JSON.stringify({ event: 'listening', port: config.port })),
  )
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = Math.min(30000, config.requestTimeoutMs)
  server.setTimeout(config.requestTimeoutMs)
  server.keepAliveTimeout = 5000
  let closing = false
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      if (closing) return
      closing = true
      server.close(() => process.exit(0))
      setTimeout(() => {
        server.closeAllConnections()
        process.exit(1)
      }, 25000).unref()
    })
} catch {
  console.error(
    'Startup failed: check the documented environment configuration',
  )
  process.exitCode = 1
}
