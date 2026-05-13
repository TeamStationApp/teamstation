import express from 'express'
import http from 'http'
import path from 'path'
import { makeExpressRoute } from 'serverlet/express'

import { initializeRtmpSplitter } from './rtmp/splitter'
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

  // Start the HTTP server first:
  const { listenPort = 8008, listenHost } = serverConfig
  const httpServer = http.createServer(app)

  // Initialize WebSocket server BEFORE adding Express routes
  initializeWebSocketServer(httpServer)

  // API routes must come before static files
  app.use('/api', makeExpressRoute(allRoutes))

  // Serve static assets
  app.use('/assets', express.static('dist/assets'))
  app.get('/bundle.js', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../dist/bundle.js'))
  })
  app.get('/bundle.js.LICENSE.txt', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../dist/bundle.js.LICENSE.txt'))
  })

  // SPA routes - serve index.html for dashboard, scoreboard, links, and split routes
  app.get(/^\/(dashboard|scoreboard|links|split).*/, (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../dist/index.html'))
  })

  // Root route
  app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../dist/index.html'))
  })

  // Start listening
  httpServer.listen(listenPort, listenHost)
  logger(`HTTP server listening on port ${listenPort}`)

  // Start RTMP splitter (independent TCP listener on rtmpPort)
  initializeRtmpSplitter()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
