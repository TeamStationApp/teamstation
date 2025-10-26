import express from 'express'
import http from 'http'
import path from 'path'
import { makeExpressRoute } from 'serverlet/express'

import { serverConfig } from './serverConfig'
import { initializeWebSocketServer } from './sockets'
import { allRoutes } from './urls'
import { logger } from './util/utils'

async function main(): Promise<void> {
  await server()
}

async function server(): Promise<void> {
  // createSyncInterval(settingsReplication, dbSettings)

  // Set up Express:
  const app = express()
  app.enable('trust proxy')
  app.use(express.json({ limit: '15mb' }))

  // API routes must come before static files
  app.use('/api', makeExpressRoute(allRoutes))

  // Serve static files
  app.use(express.static('dist'))

  // SPA fallback - serve index.html for all other routes
  app.use((req, res) => {
    res.sendFile(path.resolve(__dirname, '../../dist/index.html'))
  })

  // Start the HTTP server:
  const { listenPort = 8008, listenHost } = serverConfig
  const httpServer = http.createServer(app)
  httpServer.listen(listenPort, listenHost)
  logger(`HTTP server listening on port ${listenPort}`)

  // Initialize WebSocket server
  initializeWebSocketServer(httpServer)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
