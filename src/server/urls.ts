import { pickMethod, pickPath, type Serverlet, withCors } from 'serverlet'

import { withLogging } from './middleware/withLogging'
import {
  postLwsAddressInfo,
  postLwsAddressTxs,
  postLwsLogin,
  postLwsRandomOuts,
  postLwsSubmitRawTx,
  postLwsUnspentOuts
} from './routes/lwsRoutes'
import type { LwsRequest } from './types/types'
import { statusCodes, statusResponse, successResponse } from './types/types'

const missingRoute = withLogging('missing', (request: LwsRequest) =>
  statusResponse(
    request,
    statusCodes.notFound,
    `Unknown API endpoint ${request.path}`
  )
)

const healthCheckRoute = withLogging('healthCheck', (request: LwsRequest) =>
  successResponse(request, { status: 'ok', service: 'monero-lws-balancer' })
)

const urls: Record<string, Serverlet<LwsRequest>> = {
  '/': healthCheckRoute,

  // Monero LWS endpoints - ONLY the requested endpoints, all POST
  '/get_address_info': pickMethod({
    POST: withLogging('postLwsAddressInfo', postLwsAddressInfo)
  }),

  '/get_address_txs': pickMethod({
    POST: withLogging('postLwsAddressTxs', postLwsAddressTxs)
  }),

  '/get_random_outs': pickMethod({
    POST: withLogging('postLwsRandomOuts', postLwsRandomOuts)
  }),

  '/get_unspent_outs': pickMethod({
    POST: withLogging('postLwsUnspentOuts', postLwsUnspentOuts)
  }),

  '/login': pickMethod({
    POST: withLogging('postLwsLogin', postLwsLogin)
  }),

  '/submit_raw_tx': pickMethod({
    POST: withLogging('postLwsSubmitRawTx', postLwsSubmitRawTx)
  })
}

export const allRoutes = withCors(pickPath(urls, missingRoute))
