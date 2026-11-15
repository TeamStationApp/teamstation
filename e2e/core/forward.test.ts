import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server
} from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sendReply, upstreamFailed } from './forward'

async function listen(server: Server): Promise<number> {
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** GETs `port`, resolving with the status, or 'broken' when the connection breaks. */
async function get(port: number): Promise<number | 'broken'> {
  return await new Promise(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, res => {
      res.on('data', () => {})
      res.on('end', () => {
        resolve(res.statusCode ?? 0)
      })
      res.on('error', () => {
        resolve('broken')
      })
      res.on('aborted', () => {
        resolve('broken')
      })
    })
    req.on('error', () => {
      resolve('broken')
    })
    req.end()
  })
}

describe('forwarding an upstream reply', function () {
  it('loses only the request whose upstream dies mid-reply, and answers a dead upstream 502', async function () {
    // An upstream that sends headers and half a body, then dies.
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '100' })
      res.write('half')
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const upstreamPort = await listen(upstream)
    const forwarding = createServer((req, res) => {
      const out = httpRequest(
        { host: '127.0.0.1', port: upstreamPort, path: req.url },
        (reply: IncomingMessage) => {
          sendReply(reply, res, reply.statusCode ?? 502)
        }
      )
      out.on('error', () => {
        upstreamFailed(res)
      })
      out.end()
    })
    const port = await listen(forwarding)
    try {
      expect(await get(port)).equals('broken')
      // The forwarding server is still up for the next request.
      expect(await get(port)).equals('broken')
      upstream.close()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(await get(port)).equals(502)
    } finally {
      forwarding.close()
      upstream.close()
    }
  })
})
