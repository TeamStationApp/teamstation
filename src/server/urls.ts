import { pickMethod, pickPath, type Serverlet, withCors } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { withApiKey } from './middleware/withApiKey'
import { withLogging } from './middleware/withLogging'
import { postTestRoute } from './routes/routes'
import {
  deleteSplitRoute,
  getSplitConfigRoute,
  getSplitRoute,
  postSplitRoute
} from './routes/splitRoutes'
import { statusCodes, statusResponse, successResponse } from './types/types'

const missingRoute = withLogging('missing', (request: ExpressRequest) =>
  statusResponse(
    request,
    statusCodes.notFound,
    `Unknown API endpoint ${request.path}`
  )
)

const healthCheckRoute = withLogging('healthCheck', (request: ExpressRequest) =>
  successResponse(request, { status: 'ok', service: 'monero-lws-balancer' })
)

const splitEventIdPattern = '/v1/split/[a-zA-Z0-9_-]+'

const urls: Record<string, Serverlet<ExpressRequest>> = {
  '/': healthCheckRoute,

  '/v1/testRoute': pickMethod({
    POST: withLogging('testRoute', withApiKey(postTestRoute))
  }),

  '/v1/split/config': pickMethod({
    GET: withLogging('getSplitConfig', getSplitConfigRoute)
  }),

  [splitEventIdPattern]: pickMethod({
    GET: withLogging('getSplit', getSplitRoute),
    POST: withLogging('postSplit', postSplitRoute),
    DELETE: withLogging('deleteSplit', deleteSplitRoute)
  })
}

export const allRoutes = withCors(pickPath(urls, missingRoute))
