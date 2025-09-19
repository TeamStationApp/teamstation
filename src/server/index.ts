import cluster from 'cluster'
import cors from 'cors'
import { forkChildren } from 'edge-server-tools'
import express from 'express'
import http from 'http'

import { logging } from './logging'
import { topRouter } from './router'
import { serverConfig } from './serverConfig'

const app = express()

// Add analytics:
app.use(logging)

// Use bodyParser to get the data from a POST:
app.use(express.json({ limit: '15mb' }))

// Allow CORS requests:
app.use(cors())

// Route API and other specific paths to topRouter
app.use('/', topRouter)

async function main(): Promise<void> {
  const { listenPort = 8008, listenHost } = serverConfig
  if (cluster.isPrimary) {
    forkChildren()
  } else {
    // Start the HTTP server:
    const httpServer = http.createServer(app)
    httpServer.listen(listenPort, listenHost)
    console.log(`HTTP server listening on port ${listenPort}`)
  }
}

main().catch((e: unknown) => {
  console.log(e)
})
