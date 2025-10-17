import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import {
  asLwsKeys,
  type LwsKeys,
  type LwsRequest,
  statusCodes,
  statusResponse
} from '../types/types'

export function withKeys(
  serverlet: Serverlet<LwsRequest>
): Serverlet<ExpressRequest> {
  return async request => {
    const { req } = request
    const { body } = req

    let keys: LwsKeys
    try {
      keys = asLwsKeys(body)
    } catch (e: unknown) {
      if (e instanceof Error) {
        return statusResponse(request, statusCodes.badRequest, e.message)
      } else {
        return statusResponse(request, statusCodes.badRequest, 'Invalid keys')
      }
    }

    const {
      address,
      api_key: apiKey,
      view_key: viewKey,
      birthday_height: birthdayHeight
    } = keys

    return await serverlet({
      ...request,
      address,
      apiKey,
      viewKey,
      birthdayHeight
    })
  }
}
