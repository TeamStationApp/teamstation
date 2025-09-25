import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { asLwsKeys, type LwsRequest } from '../types/types'

export function withKeys(
  serverlet: Serverlet<LwsRequest>
): Serverlet<ExpressRequest> {
  return async request => {
    const { req } = request
    const { body } = req

    const {
      address,
      api_key: apiKey,
      view_key: viewKey,
      birthday_height: birthdayHeight
    } = asLwsKeys(body)

    return await serverlet({
      ...request,
      address,
      apiKey,
      viewKey,
      birthdayHeight
    })
  }
}
