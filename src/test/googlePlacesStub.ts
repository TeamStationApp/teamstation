import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export async function googlePlacesStub(): Promise<{
  baseUrl: string
  calls: Array<{ path: string; mask: string; key: string; body: unknown }>
  controls: {
    fail: boolean
    delay: number
    timeZoneFail: boolean
    timeZoneDelay: number
  }
  close: () => Promise<void>
}> {
  const calls: Array<{
    path: string
    mask: string
    key: string
    body: unknown
  }> = []
  const controls = {
    fail: false,
    delay: 0,
    timeZoneFail: false,
    timeZoneDelay: 0
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = raw === '' ? undefined : (JSON.parse(raw) as unknown)
      calls.push({
        path: req.url!,
        mask: String(req.headers['x-goog-fieldmask'] ?? ''),
        key: String(
          req.headers['x-goog-api-key'] ??
            new URL(req.url!, 'http://localhost').searchParams.get('key') ??
            ''
        ),
        body
      })
      const answer = (): void => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url!.startsWith('/maps/api/timezone/json')) {
          const [latitude, longitude] = new URL(
            req.url!,
            'http://localhost'
          ).searchParams
            .get('location')!
            .split(',')
            .map(Number)
          const finish = (): void => {
            res.end(
              JSON.stringify(
                controls.timeZoneFail
                  ? { status: 'REQUEST_DENIED' }
                  : {
                      status: 'OK',
                      timeZoneId:
                        longitude > 100
                          ? 'Asia/Singapore'
                          : longitude > -10
                            ? 'Europe/Lisbon'
                            : latitude > 40
                              ? 'America/Toronto'
                              : 'America/Chicago'
                    }
              )
            )
          }
          if (controls.timeZoneDelay > 0)
            setTimeout(finish, controls.timeZoneDelay)
          else finish()
          return
        }
        if (controls.fail) {
          res.writeHead(503)
          res.end('{}')
          return
        }
        if (req.url === '/v1/places:autocomplete') {
          const query = (body as { input: string }).input.toLowerCase()
          const ids = query.startsWith('tor')
            ? ['toronto']
            : query.startsWith('sin')
              ? ['singapore']
              : query === 'au'
                ? ['austin', ...Array.from({ length: 7 }, (_, n) => `au${n}`)]
                : query.startsWith('aus')
                  ? ['austin']
                  : []
          res.end(
            JSON.stringify({
              suggestions: ids.map(id => ({
                placePrediction: {
                  placeId: id,
                  structuredFormat: {
                    mainText: {
                      text:
                        id === 'austin'
                          ? 'Austin'
                          : id === 'toronto'
                            ? 'Toronto'
                            : id === 'singapore'
                              ? 'Singapore'
                              : `Auburn ${id.slice(2)}`
                    },
                    secondaryText: {
                      text:
                        id === 'toronto'
                          ? 'Ontario, Canada'
                          : id === 'singapore'
                            ? 'Singapore'
                            : 'Texas, United States'
                    }
                  }
                }
              }))
            })
          )
          return
        }
        const id = new URL(req.url!, 'http://localhost').pathname
          .split('/')
          .at(-1)
        if (
          ![
            'austin',
            'toronto',
            'singapore',
            'postal',
            'township',
            'no-city',
            'bemposta'
          ].includes(id!)
        ) {
          res.writeHead(404)
          res.end('{}')
          return
        }
        const city =
          id === 'bemposta'
            ? 'Bemposta'
            : id === 'toronto'
              ? 'Toronto'
              : id === 'singapore'
                ? 'Singapore'
                : 'Austin'
        const country =
          id === 'bemposta'
            ? 'Portugal'
            : id === 'toronto'
              ? 'Canada'
              : id === 'singapore'
                ? 'Singapore'
                : 'United States'
        res.end(
          JSON.stringify({
            addressComponents: [
              ...(id === 'no-city'
                ? []
                : [
                    {
                      longText: city,
                      types: [
                        id === 'postal'
                          ? 'postal_town'
                          : id === 'township'
                            ? 'administrative_area_level_3'
                            : 'locality'
                      ]
                    }
                  ]),
              ...(id === 'singapore'
                ? []
                : [
                    {
                      longText:
                        id === 'bemposta'
                          ? 'Bragança'
                          : id === 'toronto'
                            ? 'Ontario'
                            : 'Texas',
                      types: ['administrative_area_level_1']
                    }
                  ]),
              { longText: country, types: ['country'] }
            ],
            location:
              id === 'bemposta'
                ? { latitude: 41.315, longitude: -6.511 }
                : id === 'toronto'
                  ? { latitude: 43.6532, longitude: -79.3832 }
                  : id === 'singapore'
                    ? { latitude: 1.3521, longitude: 103.8198 }
                    : { latitude: 30.2672, longitude: -97.7431 }
          })
        )
      }
      if (controls.delay > 0) setTimeout(answer, controls.delay)
      else answer()
    })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    controls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error != null) reject(error)
          else resolve()
        })
      })
    }
  }
}
