import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { apiKeysSyncDoc } from '../db/couch'
import { asLwsApiKey, statusCodes, statusResponse } from '../types/types'

export function withApiKey(
  serverlet: Serverlet<ExpressRequest>
): Serverlet<ExpressRequest> {
  return async request => {
    const { req } = request
    const { api_key: apiKey } = asLwsApiKey(req.body)

    const apiKeysDoc = apiKeysSyncDoc.doc
    const apiKeyDoc = apiKeysDoc.apiKeys[apiKey]
    if (apiKeyDoc?.status !== 'active') {
      return statusResponse(request, statusCodes.unauthorized, 'Unauthorized')
    }

    return await serverlet(request)
  }
}
