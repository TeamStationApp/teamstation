import type { LwsRequest } from './requestTypes'

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
  request: LwsRequest,
  data?: any
): ServerletResponse {
  return {
    status: statusCodes.ok,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? { success: true })
  }
}

export function statusResponse(
  request: LwsRequest,
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
  request: LwsRequest,
  data: any,
  status: number = statusCodes.ok
): ServerletResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }
}
