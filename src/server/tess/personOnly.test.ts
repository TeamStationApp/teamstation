import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type TessWorld, tessWorld } from '../../test/tessFakes'
import { currentActor } from '../groups/rights'
import { TESS_HEADER } from '../middleware/withAuth'
import { activeHuman } from '../oauth/provider'
import { deviceEventControlRoutes } from '../routes/deviceEventControl'
import { locationRoutes } from '../routes/location'
import { meRoutes } from '../routes/me'
import { onboardingRoutes } from '../routes/onboarding'
import { pictureRoutes } from '../routes/pictures'
import { apiCall } from './loopback'

const SECRET =
  '00000000000000000000000000000000000000000000000000000000000000a1'

/**
 * The routes for the person alone refuse Tess on the server itself, not only
 * on her deny list: a request her tools send carries the person's own
 * session, and the server takes it as a machine's. A client that sends the
 * header itself is taken the same way, so the header never lets anyone
 * further than they could go without it.
 */
describe('Routes for the person alone, asked by Tess', function () {
  this.timeout(60000)
  let w: TessWorld

  before(async () => {
    w = await tessWorld({
      mountExtra: (app, { db, media }) => {
        app.use('/api/v1', meRoutes(db, 'https://builds.example.test'))
        app.use(
          '/api/v1',
          deviceEventControlRoutes(db, {
            secret: SECRET,
            issuer: 'https://app.example.test'
          })
        )
        app.use('/api/v1', onboardingRoutes(db, media))
        app.use('/api/v1', pictureRoutes(db, media.space))
        app.use(
          '/api/v1',
          locationRoutes(undefined, {
            db,
            googlePlaces: {
              autocomplete: async () => [
                { id: 'google:demo', primary: 'Demo City', secondary: 'Demo' }
              ],
              locality: async () => {
                throw new Error('Not in this test')
              },
              eventPlaces: async () => [],
              coordinates: async () => {
                throw new Error('Not in this test')
              },
              venueDetails: async () => {
                throw new Error('Not in this test')
              }
            }
          })
        )
      }
    })
  })
  after(async () => {
    await w?.close()
  })

  /** The status a request answers as the person, and as Tess. */
  const statuses = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ person: number; tess: number }> => {
    const send = async (tess: boolean): Promise<number> =>
      (
        await fetch(`${w.h.origin}/api/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...(tess ? { [TESS_HEADER]: '1' } : {})
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      ).status
    return { person: await send(false), tess: await send(true) }
  }

  it('keeps the device key and the test builds link, which ask activeHuman, from Tess', async () => {
    expect(await statuses('GET', '/device-event-control/key')).deep.equals({
      person: 200,
      tess: 401
    })
    expect(await statuses('GET', '/me/builds')).deep.equals({
      person: 200,
      tess: 401
    })
    const actor = {
      userId: w.userId(101),
      isAdmin: false,
      scopes: [],
      sessionId: 'ses_1'
    }
    expect(await activeHuman(w.h.db, { ...actor, viaTess: true })).equals(
      undefined
    )
  })

  it('keeps the account and its first-run setup from Tess', async () => {
    expect(await statuses('GET', '/me/account')).deep.equals({
      person: 200,
      tess: 403
    })
    expect(await statuses('GET', '/me/onboarding')).deep.equals({
      person: 200,
      tess: 401
    })
    // The picture is checked before anything is chosen, so neither changes.
    expect(
      (await statuses('PUT', '/me/account/catalog-picture', {})).tess
    ).equals(401)
  })

  it('gives Tess the built-in city catalogue, never the paid suggestions', async () => {
    const providers = async (tess: boolean): Promise<unknown> =>
      (
        (await (
          await fetch(`${w.h.origin}/api/v1/locations?query=Demo&session=s1`, {
            headers: {
              authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
              ...(tess ? { [TESS_HEADER]: '1' } : {})
            }
          })
        ).json()) as { provider: string }
      ).provider
    expect(await providers(false)).equals('google')
    expect(await providers(true)).equals('geonames')
    const place = await fetch(
      `${w.h.origin}/api/v1/locations/google:demo?session=s1`,
      {
        headers: {
          authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
          [TESS_HEADER]: '1'
        }
      }
    )
    expect(place.status).equals(401)
  })

  it('keeps her own routes from her', async () => {
    expect((await statuses('GET', '/me/tess')).tess).equals(403)
  })

  it('refuses these at the deny list first, so nothing is sent', async () => {
    let sent = 0
    const answer = await apiCall(
      w.h.origin,
      { authorization: `Bearer ${w.h.tokens.get(101) ?? ''}` },
      'GET',
      '/device-event-control/key',
      undefined,
      undefined,
      {
        fetch: (async () => {
          sent += 1
          return new Response('{}')
        }) as unknown as typeof fetch
      }
    )
    expect(answer.status).equals(403)
    expect(sent).equals(0)
  })

  it('lets her manage organizations for the person, since each change waits for their hold', async () => {
    const actor = {
      userId: w.userId(101),
      isAdmin: false,
      scopes: [],
      sessionId: 'ses_1',
      viaTess: true as const
    }
    expect((await currentActor(w.h.db, actor)).userId).equals(w.userId(101))
  })
})
