import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  seedThrough
} from './autoSchedulerFixture'
import { googlePlacesStub } from './googlePlacesStub'

/**
 * The scheduler's world as E6 leaves it, for server tests: Example Park
 * claimed by leagueA with Field 1, G1 and a second game on it, the two
 * exhibition teams flagged, seasonA's settings, and seasonA and Field 1
 * chosen for the run.
 */
export interface SchedulerWorld {
  fx: AutoSchedulerFixture
  venueId: string
  fieldId: string
  close: () => Promise<void>
  /** Calls the API as a fixture user and returns the status and body. */
  call: <T = unknown>(
    user: number,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: T }>
}

export async function schedulerWorld(): Promise<SchedulerWorld> {
  const places = await googlePlacesStub()
  const fx = await autoSchedulerFixture(undefined, {
    cityLookup: googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: places.baseUrl
    })
  })
  try {
    const state = await seedThrough(fx, 'E7')
    return {
      fx,
      venueId: state.venueId!,
      fieldId: state.fieldId!,
      close: async () => {
        await fx.f.h.close()
        await places.close()
      },
      call: async <T>(
        user: number,
        method: string,
        path: string,
        body?: unknown
      ) => {
        const response = await fx.f.h.request(method, path, body, user)
        const text = await response.text()
        return {
          status: response.status,
          body: (text === '' ? undefined : JSON.parse(text)) as T
        }
      }
    }
  } catch (error) {
    await fx.f.h.close()
    await places.close()
    throw error
  }
}

export { api }
