import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { statusCodes, statusResponse, successResponse } from '../types/types'

export const postTestRoute: Serverlet<ExpressRequest> = async (
  request: ExpressRequest
) => {
  try {
    return successResponse(request, { message: 'Hello, world!' })
  } catch (error) {
    return statusResponse(
      request,
      statusCodes.internalError,
      'Internal server error'
    )
  }
}
