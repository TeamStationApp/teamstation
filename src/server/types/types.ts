import {
  asDate,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'
import { asCouchDoc } from 'edge-server-tools'
import type { ExpressRequest } from 'serverlet/express'

export type LwsRequest = ExpressRequest & {
  address: string
  apiKey: string
  viewKey: string
  birthdayHeight?: number
}

export const statusCodes = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  internalError: 500
} as const

export interface ServerletResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function successResponse(
  request: ExpressRequest,
  data?: any
): ServerletResponse {
  return {
    status: statusCodes.ok,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? { success: true })
  }
}

export function statusResponse(
  request: ExpressRequest,
  status: number,
  message: string
): ServerletResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message })
  }
}

export function jsonResponse(
  request: ExpressRequest,
  data: any,
  status: number = statusCodes.ok
): ServerletResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }
}

export const asLwsAddress = asObject({
  _id: asOptional(asString),
  _rev: asOptional(asString),
  address: asString,
  birthdayHeight: asNumber,
  lastVisitedDate: asDate,
  firstSeenDate: asDate,
  shard: asOptional(asEither(asNumber, asNull), null),
  viewKey: asString
})

export const asLwsAddressDoc = asCouchDoc(asLwsAddress)

export const asApiKeys = asObject({
  apiKeys: asOptional(
    asObject(
      asObject({
        apiKey: asString,
        email: asString,
        status: asValue('active', 'disabled'),
        createdAt: asDate
      })
    ),
    {}
  )
})

export const asLwsApiKey = asObject({
  api_key: asString
})

export const asLwsKeys = asObject({
  ...asLwsApiKey.shape,
  address: asString,
  view_key: asString,
  birthday_height: asOptional(asNumber)
})

// export const asLwsSpentOutput = asObject({
//   amount: asString,
//   key_image: asString,
//   tx_pub_key: asString,
//   out_index: asNumber,
//   mixin: asNumber,
//   sender: asObject({
//     maj_i: asNumber,
//     min_i: asNumber
//   })
// })

export const asLwsAddressInfo = asObject({
  // locked_funds: asString,
  // total_received: asString,
  // total_sent: asString,
  // scanned_height: asNumber,
  // scanned_block_height: asNumber,
  start_height: asNumber,
  // transaction_height: asNumber,
  blockchain_height: asNumber
  // spent_outputs: asArray(asLwsSpentOutput)
})

export type LwsKeys = ReturnType<typeof asLwsKeys>
export type LwsAddress = ReturnType<typeof asLwsAddress>
export type LwsAddressDoc = ReturnType<typeof asLwsAddressDoc>
export type LwsAddressInfo = ReturnType<typeof asLwsAddressInfo>
