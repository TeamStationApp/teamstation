import { pickMethod, pickPath, type Serverlet, withCors } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { withApiKey } from './middleware/withApiKey'
import { withLogging } from './middleware/withLogging'
import { postTestRoute } from './routes/routes'
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

const urls: Record<string, Serverlet<ExpressRequest>> = {
  '/': healthCheckRoute,

  '/v1/testRoute': pickMethod({
    POST: withLogging('testRoute', withApiKey(postTestRoute))
  })
}

export const allRoutes = withCors(pickPath(urls, missingRoute))
