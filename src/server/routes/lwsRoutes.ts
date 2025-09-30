import type { HttpResponse, Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { getAddress, updateAddress } from '../db/couch'
import { serverConfig } from '../serverConfig'
import {
  asLwsAddressInfo,
  type LwsAddress,
  type LwsRequest
} from '../types/types'
import { logger } from '../util/utils'

function selectRandomLwsServer(): string {
  // const servers = serverConfig.lwsServers
  // const randomIndex = Math.floor(Math.random() * servers.length)
  // return servers[randomIndex].url
  // XXX Hardcode to proxy mymonero.com
  return serverConfig.myMoneroServer
}

async function makeLwsRequest(
  path: string,
  method: string = 'POST',
  body?: any
): Promise<Response> {
  const lwsServerUrl = selectRandomLwsServer()
  const targetUrl = `${lwsServerUrl}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  body.api_key = serverConfig.myMoneroApiKey

  const requestOptions: RequestInit = {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  }

  return await fetch(targetUrl, requestOptions)
}

async function handleLwsResponse(response: Response): Promise<HttpResponse> {
  const headersToForward = [
    'content-type',
    'content-length',
    'cache-control',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers'
  ]

  const forwardedHeaders: Record<string, string> = {}
  headersToForward.forEach(header => {
    const value = response.headers.get(header)
    if (value != null) {
      forwardedHeaders[header] = value
    }
  })

  const responseText = await response.text()

  return {
    status: response.status,
    headers: forwardedHeaders,
    body: responseText
  }
}

function handleLwsError(error: unknown): HttpResponse {
  console.error('Error proxying to LWS server:', error)
  return {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'Failed to connect to Monero LWS server',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

// Individual LWS endpoint implementations - ONLY the requested endpoints

export const postLwsAddressInfo: Serverlet<LwsRequest> = async request => {
  const { address, viewKey } = request
  let responseText: string | undefined
  try {
    const response = await makeLwsRequest(
      '/get_address_info',
      'POST',
      request.req.body
    )
    const out = await handleLwsResponse(response)
    responseText = out.body as string
    return out
  } catch (error) {
    return handleLwsError(error)
  } finally {
    try {
      if (responseText != null) {
        const { start_height: birthdayHeight } = asLwsAddressInfo(
          JSON.parse(responseText)
        )
        const existingAddress = await getAddress(address)
        const now = new Date()
        if (existingAddress != null) {
          existingAddress.doc.lastVisitedDate = now
          existingAddress.doc._id = existingAddress.id
          existingAddress.doc._rev = existingAddress.rev
          await updateAddress(existingAddress.doc)
          logger(
            '/get_address_info: Updated address',
            address,
            now.toISOString()
          )
        } else {
          const newAddress: LwsAddress = {
            _id: address,
            _rev: undefined,
            address,
            birthdayHeight,
            lastVisitedDate: now,
            firstSeenDate: now,
            shard: null,
            viewKey
          }
          await updateAddress(newAddress)
          logger('/get_address_info: Added address', address, birthdayHeight)
        }
      }
    } catch (error) {
      logger('/get_address_info: Error updating address', address, error)
    }
  }
}

export const postLwsAddressTxs: Serverlet<LwsRequest> = async request => {
  try {
    const response = await makeLwsRequest(
      '/get_address_txs',
      'POST',
      request.req.body
    )
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
  }
}

export const postLwsRandomOuts: Serverlet<ExpressRequest> = async request => {
  try {
    const response = await makeLwsRequest(
      '/get_random_outs',
      'POST',
      request.req.body
    )
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
  }
}

export const postLwsUnspentOuts: Serverlet<LwsRequest> = async request => {
  try {
    const response = await makeLwsRequest(
      '/get_unspent_outs',
      'POST',
      request.req.body
    )
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
  }
}

export const postLwsLogin: Serverlet<LwsRequest> = async request => {
  try {
    const response = await makeLwsRequest('/login', 'POST', request.req.body)
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
  }
}

export const postLwsSubmitRawTx: Serverlet<LwsRequest> = async request => {
  try {
    const response = await makeLwsRequest(
      '/submit_raw_tx',
      'POST',
      request.req.body
    )
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
  }
}
