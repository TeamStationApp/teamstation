import cluster from 'cluster'
import { forkChildren } from 'edge-server-tools'
import express from 'express'
import http from 'http'
import { makeExpressRoute } from 'serverlet/express'

import { serverConfig } from './serverConfig'
import { allRoutes } from './urls'

async function main(): Promise<void> {
  if (cluster.isPrimary) {
    forkChildren()
  } else {
    await server()
  }
}

async function server(): Promise<void> {
  // Set up Express:
  const app = express()
  app.enable('trust proxy')
  app.use(express.json({ limit: '15mb' }))
  app.use('/', makeExpressRoute(allRoutes))

  // Start the HTTP server:
  const { listenPort = 8008, listenHost } = serverConfig
  const httpServer = http.createServer(app)
  httpServer.listen(listenPort, listenHost)
  console.log(`HTTP server listening on port ${listenPort}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
