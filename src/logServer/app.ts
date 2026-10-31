import { timingSafeEqual } from 'node:crypto'

import express, { type ErrorRequestHandler } from 'express'

import {
  type AppCode,
  APPS,
  parseBatch
} from '../common/observability/contract'
import { RateLimit } from '../common/observability/rateLimit'
import { envelope } from './envelope'
import { environment, type OpenSearch } from './openSearch'
import type { LogSpool } from './spool'

export interface CollectorConfig {
  origins: string[]
  readToken: string
  serverWriteToken?: string
  projects: Record<string, { app: AppCode; environment: string }>
}
export function collector(
  config: CollectorConfig,
  spool: LogSpool,
  sink: Pick<OpenSearch, 'search'>
): express.Express {
  if (config.readToken.length < 32)
    throw new Error('Read token must be at least 32 characters')
  if (config.serverWriteToken != null && config.serverWriteToken.length < 32)
    throw new Error('Server write token must be at least 32 characters')
  for (const [key, project] of Object.entries(config.projects)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !APPS.includes(project.app))
      throw new Error('Invalid project')
    environment(project.environment)
  }
  for (const origin of config.origins)
    if (new URL(origin).origin !== origin)
      throw new Error('Invalid allowed origin')
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  const rate = new RateLimit(120)
  app.use((req, res, next) => {
    if (req.path.startsWith('/ingest/') || req.path.startsWith('/api/')) {
      res.vary('Origin')
      const origin = req.header('origin')
      if (origin != null && config.origins.includes(origin))
        res.set('Access-Control-Allow-Origin', origin)
    }
    if (!rate.allow(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'rate_limited' })
      return
    }
    next()
  })
  app.get('/health', (_req, res) => {
    res.status(spool.status().healthy ? 200 : 503).json(spool.status())
  })
  app.post(
    '/search',
    (req, res, next) => {
      const provided = Buffer.from(req.header('authorization') ?? '')
      const expected = Buffer.from('Bearer ' + config.readToken)
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      next()
    },
    express.json({ limit: '16kb' }),
    async (req, res) => {
      try {
        const result = await sink.search(req.body)
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 1048576) {
          res.status(413).json({ error: 'result_too_large' })
          return
        }
        res.type('json').send(text)
      } catch {
        res.status(400).json({ error: 'search_unavailable_or_invalid' })
      }
    }
  )
  app.use(['/ingest/:project', '/api/:project/envelope'], (req, res, next) => {
    const origin = req.header('origin')
    res.vary('Origin')
    if (origin != null) {
      if (!config.origins.includes(origin)) {
        res.status(403).json({ error: 'origin_not_allowed' })
        return
      }
      res.set('Access-Control-Allow-Origin', origin)
    }
    if (req.method === 'OPTIONS') {
      if (req.header('access-control-request-method') !== 'POST') {
        res.sendStatus(405)
        return
      }
      const requested = (req.header('access-control-request-headers') ?? '')
        .toLowerCase()
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
      if (requested.some(x => !['content-type', 'x-sentry-auth'].includes(x))) {
        res.sendStatus(403)
        return
      }
      res
        .set('Access-Control-Allow-Methods', 'POST')
        .set('Access-Control-Allow-Headers', 'Content-Type, X-Sentry-Auth')
        .sendStatus(204)
      return
    }
    next()
  })
  app.post(
    ['/ingest/:project', '/api/:project/envelope'],
    express.raw({ type: () => true, limit: '256kb' }),
    async (req, res) => {
      const project = config.projects[String(req.params.project)]
      if (
        project == null ||
        !Object.hasOwn(config.projects, String(req.params.project))
      ) {
        res.status(404).json({ error: 'unknown_project' })
        return
      }
      let rows
      try {
        const body: unknown = req.body
        if (!Buffer.isBuffer(body)) throw new Error('No event bytes')
        const bytes = Buffer.from(body)
        rows = req.path.startsWith('/api/')
          ? envelope(bytes, project.app)
          : parseBatch(bytes.toString('utf8'))
        if (rows.some(row => row.U !== undefined)) {
          const provided = Buffer.from(req.header('authorization') ?? '')
          const expected = Buffer.from(
            'Bearer ' + (config.serverWriteToken ?? '')
          )
          if (
            project.app !== 'TS srv' ||
            config.serverWriteToken == null ||
            provided.length !== expected.length ||
            !timingSafeEqual(provided, expected)
          ) {
            res.status(403).json({ error: 'untrusted_actor' })
            return
          }
        }
        rows = rows.map(row => ({
          ...row,
          A: project.app,
          N: project.environment,
          T: new Date().toISOString()
        }))
      } catch {
        res.status(400).json({ error: 'invalid_events' })
        return
      }
      try {
        await spool.append(rows)
        // Sentry's Android transport requires 200 to acknowledge and remove its cached envelope.
        res
          .status(req.path.startsWith('/api/') ? 200 : 202)
          .json({ accepted: rows.length })
      } catch {
        res.status(503).json({ error: 'storage_unavailable' })
      }
    }
  )
  const failure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(413).json({ error: 'invalid_body' })
  }
  app.use(failure)
  return app
}
