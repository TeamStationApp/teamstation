import {
  asBoolean,
  asDate,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'
import type { ExpressRequest } from 'serverlet/express'

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

export const asApiKey = asObject({
  api_key: asString
})

export const asScoreState = asObject({
  pitcherName: asString,
  batterName: asString,
  batterNumber: asNumber,
  batterNumHits: asNumber,
  batterAtBats: asNumber,
  numPitches: asNumber,
  balls: asNumber,
  strikes: asNumber,
  outs: asNumber,
  base1: asBoolean,
  base2: asBoolean,
  base3: asBoolean,
  inning: asNumber,
  half: asValue('top', 'bottom'),
  teams: asObject({ home: asString, away: asString }),
  scores: asObject({ home: asNumber, away: asNumber })
})

export type ScoreState = ReturnType<typeof asScoreState>
