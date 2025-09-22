import type { ExpressRequest } from 'serverlet/express'

export interface LwsRequest extends ExpressRequest {
  // Extended request interface for LWS operations
  // The ExpressRequest already has req.body, req.query, req.ip through the req property
}
