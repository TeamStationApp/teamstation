import { asArray, asObject, asString } from 'cleaners'
import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import {
  getIngressUrl,
  getSplitConfig,
  getStatusSnapshot,
  setSplit,
  stopSplit
} from '../rtmp/splitter'
import { statusCodes, statusResponse, successResponse } from '../types/types'

const asSetSplitBody = asObject({
  destinations: asArray(asString)
})

const EVENT_ID_RE = /^\/v1\/split\/([a-zA-Z0-9_-]+)$/

function extractEventId(path: string): string | null {
  const match = EVENT_ID_RE.exec(path)
  if (match == null) return null
  return match[1]
}

export const getSplitConfigRoute: Serverlet<ExpressRequest> = async request => {
  return successResponse(request, getSplitConfig())
}

export const getSplitRoute: Serverlet<ExpressRequest> = async request => {
  const eventId = extractEventId(request.path)
  if (eventId == null) {
    return statusResponse(request, statusCodes.badRequest, 'Invalid eventId')
  }
  const status = getStatusSnapshot(eventId)
  return successResponse(request, {
    eventId,
    ingressUrl: getIngressUrl(eventId),
    destinations: status?.destinations ?? [],
    ingress: status?.ingress ?? {
      publishing: false,
      receivingPackets: false,
      bytesReceived: 0,
      bytesPerSecond: 0
    },
    outbounds: status?.outbounds ?? []
  })
}

export const postSplitRoute: Serverlet<ExpressRequest> = async request => {
  const eventId = extractEventId(request.path)
  if (eventId == null) {
    return statusResponse(request, statusCodes.badRequest, 'Invalid eventId')
  }
  let body: { destinations: string[] }
  try {
    body = asSetSplitBody(request.req.body)
  } catch (error) {
    return statusResponse(
      request,
      statusCodes.badRequest,
      `Invalid request body: ${String(error)}`
    )
  }
  const result = setSplit(eventId, body.destinations)
  if (!result.ok) {
    return statusResponse(
      request,
      statusCodes.badRequest,
      result.error ?? 'Failed to set split'
    )
  }
  return successResponse(request, {
    eventId,
    ingressUrl: getIngressUrl(eventId),
    destinations: result.status?.destinations ?? [],
    ingress: result.status?.ingress,
    outbounds: result.status?.outbounds ?? []
  })
}

/**
 * DELETE /api/v1/split/:eventId — deactivates forwarding for the event
 * but preserves the configured destination URLs so operators can resume
 * by re-clicking Save in the UI without retyping the destinations.
 */
export const deleteSplitRoute: Serverlet<ExpressRequest> = async request => {
  const eventId = extractEventId(request.path)
  if (eventId == null) {
    return statusResponse(request, statusCodes.badRequest, 'Invalid eventId')
  }
  const stopped = stopSplit(eventId)
  return successResponse(request, { eventId, stopped })
}
