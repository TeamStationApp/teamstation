import type { Serverlet } from 'serverlet'
import type { ExpressRequest } from 'serverlet/express'

import { serverConfig } from '../serverConfig'
import type { LwsRequest } from '../types/types'

function selectRandomLwsServer(): string {
  const servers = serverConfig.lwsServers
  const randomIndex = Math.floor(Math.random() * servers.length)
  return servers[randomIndex].url
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

  const requestOptions: RequestInit = {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  }

  return await fetch(targetUrl, requestOptions)
}

async function handleLwsResponse(response: Response): Promise<any> {
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

function handleLwsError(error: unknown): any {
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
  try {
    const response = await makeLwsRequest(
      '/get_address_info',
      'POST',
      request.req.body
    )
    return await handleLwsResponse(response)
  } catch (error) {
    return handleLwsError(error)
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
