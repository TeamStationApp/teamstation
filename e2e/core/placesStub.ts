import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import { ROOT } from './manifest'

/** Fixed Google answers, the same file a seat's budget proxy serves in fake mode. */
export const PLACES_ANSWERS = join(
  ROOT,
  'e2e',
  'fixtures',
  'placesAnswers.json'
)

export function placesAnswer(
  answers: Record<string, unknown>,
  method: string,
  path: string
): unknown {
  const pathname = new URL(path, 'http://places').pathname
  if (pathname === '/maps/api/timezone/json') return answers.timezone
  if (pathname === '/v1/places:autocomplete') return answers.autocomplete
  if (pathname === '/v1/places:searchText') return answers.searchText
  if (method === 'GET' && pathname.startsWith('/v1/places/')) {
    return answers.placeDetails
  }
  return undefined
}

export async function startPlacesStub(
  host: string,
  file = PLACES_ANSWERS
): Promise<{ server: Server; url: string }> {
  const answers = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    unknown
  >
  const server = createServer((req, res) => {
    const answer = placesAnswer(answers, req.method ?? 'GET', req.url ?? '/')
    res.writeHead(answer == null ? 404 : 200, {
      'content-type': 'application/json'
    })
    res.end(JSON.stringify(answer ?? { error: 'not found' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address() as { port: number }
  return { server, url: `http://${host}:${address.port}` }
}
