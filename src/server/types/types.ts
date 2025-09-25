import { asNumber, asObject, asOptional, asString } from 'cleaners'
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

export const asLwsKeys = asObject({
  address: asString,
  api_key: asString,
  view_key: asString,
  birthday_height: asOptional(asNumber)
})

export type LwsKeys = ReturnType<typeof asLwsKeys>
