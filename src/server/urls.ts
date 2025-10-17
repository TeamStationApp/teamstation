import { pickMethod, pickPath, type Serverlet, withCors } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { withApiKey } from './middleware/withApiKey'
import { withKeys } from './middleware/withKeys'
import { withLogging } from './middleware/withLogging'
import {
  postLwsAddressInfo,
  postLwsAddressTxs,
  postLwsLogin,
  postLwsRandomOuts,
  postLwsSubmitRawTx,
  postLwsUnspentOuts
} from './routes/lwsRoutes'
import { statusCodes, statusResponse, successResponse } from './types/types'

const missingRoute = withLogging('missing', (request: ExpressRequest) =>
  statusResponse(
    request,
    statusCodes.notFound,
    `Unknown API endpoint ${request.path}`
  )
)

const healthCheckRoute = withLogging('healthCheck', (request: ExpressRequest) =>
  successResponse(request, { status: 'ok', service: 'teamstation' })
)

const urls: Record<string, Serverlet<ExpressRequest>> = {
  '/': healthCheckRoute,

  // Monero LWS endpoints - ONLY the requested endpoints, all POST
  '/get_address_info': pickMethod({
    POST: withLogging(
      'postLwsAddressInfo',
      withApiKey(withKeys(postLwsAddressInfo))
    )
  }),

  '/get_address_txs': pickMethod({
    POST: withLogging(
      'postLwsAddressTxs',
      withApiKey(withKeys(postLwsAddressTxs))
    )
  }),

  '/get_random_outs': pickMethod({
    POST: withLogging('postLwsRandomOuts', withApiKey(postLwsRandomOuts))
  }),

  '/get_unspent_outs': pickMethod({
    POST: withLogging(
      'postLwsUnspentOuts',
      withApiKey(withKeys(postLwsUnspentOuts))
    )
  }),

  '/login': pickMethod({
    POST: withLogging('postLwsLogin', withApiKey(withKeys(postLwsLogin)))
  }),

  '/submit_raw_tx': pickMethod({
    POST: withLogging(
      'postLwsSubmitRawTx',
      withApiKey(withKeys(postLwsSubmitRawTx))
    )
  })
}

export const allRoutes = withCors(pickPath(urls, missingRoute))
