import { asArray, asNumber, asObject, asOptional, asString } from 'cleaners'

import { invalidLocation, notFound, unavailable } from '../../common/errors'
import type { EventPlace, EventPlaceKind } from '../../common/eventPlaces'
import {
  asLocality,
  type CitySuggestion,
  type Locality
} from '../../common/locality'
import { coordinateTimezone } from './coordinateTimezone'
import type { Coordinates } from './eventGeocoder'

export interface GooglePlaces {
  autocomplete: (query: string, session: string) => Promise<CitySuggestion[]>
  locality: (id: string, session?: string) => Promise<Locality>
  eventPlaces: (
    query: string,
    kind: EventPlaceKind,
    options?: EventPlaceOptions
  ) => Promise<EventPlace[]>
  coordinates: (address: string) => Promise<Coordinates>
  /** A place by its Google id: what the venue registry stores of it. */
  venueDetails: (placeId: string) => Promise<VenuePlace>
}

/**
 * How many places an event-place search returns, five unless asked, and the
 * point Google should favour places near, 50 km around it.
 */
export interface EventPlaceOptions {
  limit?: number
  near?: Coordinates
}

/** A Google place as the venue registry takes it in. */
export interface VenuePlace {
  placeId: string
  name: string
  address: string
  latitude: number
  longitude: number
  timezone: string
}
interface PredictionReply {
  suggestions?: Array<{
    placePrediction: {
      placeId: string
      structuredFormat: {
        mainText: { text: string }
        secondaryText?: { text: string }
      }
    }
  }>
}
function predictions(raw: unknown): {
  suggestions: NonNullable<PredictionReply['suggestions']>
} {
  const result = raw as PredictionReply
  return {
    suggestions: asArray((value: unknown) => {
      const row = value as NonNullable<PredictionReply['suggestions']>[number]
      return {
        placePrediction: {
          placeId: asString(row.placePrediction.placeId),
          structuredFormat: {
            mainText: {
              text: asString(row.placePrediction.structuredFormat.mainText.text)
            },
            secondaryText:
              row.placePrediction.structuredFormat.secondaryText == null
                ? undefined
                : {
                    text: asString(
                      row.placePrediction.structuredFormat.secondaryText.text
                    )
                  }
          }
        }
      }
    })(result.suggestions ?? [])
  }
}
const details = asObject({
  addressComponents: asArray(
    asObject({ longText: asString, types: asArray(asString) })
  ),
  location: asObject({ latitude: asNumber, longitude: asNumber })
})
const venuePlace = asObject({
  id: asString,
  displayName: asOptional(asObject({ text: asString })),
  formattedAddress: asOptional(asString, ''),
  location: asObject({ latitude: asNumber, longitude: asNumber })
})
const eventPlace = asObject({
  id: asString,
  formattedAddress: asString,
  displayName: asOptional(asObject({ text: asString })),
  primaryType: asOptional(asString)
})
const coordinatePlace = asObject({
  location: asObject({ latitude: asNumber, longitude: asNumber })
})
const coordinateReply = asObject({
  places: asOptional(asArray(coordinatePlace), [])
})
const addressTypes = new Set([
  'street_address',
  'route',
  'intersection',
  'street_number',
  'postal_code',
  'postal_code_prefix',
  'postal_code_suffix',
  'locality',
  'sublocality',
  'neighborhood',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'country'
])

/** No provider response or credentials are cached or logged. */
export function googlePlaces({
  apiKey,
  baseUrl = 'https://places.googleapis.com',
  timeZoneBaseUrl = baseUrl === 'https://places.googleapis.com'
    ? 'https://maps.googleapis.com'
    : baseUrl,
  timeoutMs = 3000
}: {
  apiKey: string
  baseUrl?: string
  timeZoneBaseUrl?: string
  timeoutMs?: number
}): GooglePlaces {
  async function request(
    path: string,
    mask: string,
    body?: unknown
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(baseUrl + path, {
        method: body == null ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': mask
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw unavailable('City lookup is unavailable')
    }
    if (response.status === 404) throw notFound()
    if (!response.ok) throw unavailable('City lookup is unavailable')
    try {
      return await response.json()
    } catch {
      throw unavailable('City lookup is unavailable')
    }
  }
  return {
    async venueDetails(placeId) {
      let place: ReturnType<typeof venuePlace>
      try {
        place = venuePlace(
          await request(
            `/v1/places/${encodeURIComponent(placeId)}?languageCode=en`,
            'id,displayName,formattedAddress,location'
          )
        )
      } catch (error) {
        if (error instanceof TypeError)
          throw unavailable('Place lookup is unavailable')
        throw error
      }
      const { latitude, longitude } = place.location
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      )
        throw unavailable('The map provider returned invalid coordinates')
      const name = place.displayName?.text.trim() ?? ''
      return {
        placeId: place.id,
        name: (name === '' ? place.formattedAddress : name).slice(0, 200),
        address: place.formattedAddress.slice(0, 400),
        latitude,
        longitude,
        timezone: await coordinateTimezone(latitude, longitude, {
          apiKey,
          baseUrl: timeZoneBaseUrl,
          timeoutMs
        })
      }
    },
    async eventPlaces(query, kind, options = {}) {
      if (query.trim().length < 2) return []
      const limit = options.limit ?? 5
      try {
        const raw = await request(
          '/v1/places:searchText',
          'places.id,places.displayName,places.formattedAddress,places.primaryType',
          {
            textQuery: query.trim(),
            languageCode: 'en',
            pageSize: limit,
            ...(options.near == null
              ? {}
              : {
                  locationBias: {
                    circle: {
                      center: {
                        latitude: options.near.latitude,
                        longitude: options.near.longitude
                      },
                      radius: 50000
                    }
                  }
                })
          }
        )
        const rows = asObject({ places: asOptional(asArray(eventPlace), []) })(
          raw
        ).places
        return rows
          .filter(
            row =>
              row.formattedAddress.trim() !== '' &&
              row.formattedAddress.length <= 500 &&
              (row.displayName?.text.length ?? 0) <= 200 &&
              (kind !== 'venue' ||
                ((row.displayName?.text.trim() ?? '') !== '' &&
                  !addressTypes.has(row.primaryType ?? '')))
          )
          .slice(0, limit)
          .map(row => ({
            id: `google:${row.id}`,
            name: addressTypes.has(row.primaryType ?? '')
              ? null
              : (row.displayName?.text ?? null),
            address: row.formattedAddress
          }))
      } catch (error) {
        if (error instanceof TypeError)
          throw unavailable('Place lookup is unavailable')
        throw error
      }
    },
    async coordinates(address) {
      try {
        const raw = await request('/v1/places:searchText', 'places.location', {
          textQuery: address.trim(),
          languageCode: 'en',
          pageSize: 1
        })
        const rows = coordinateReply(raw).places
        const point = rows[0]?.location
        if (point == null)
          throw notFound(
            'The address could not be located. Check it or try again.'
          )
        if (
          !Number.isFinite(point.latitude) ||
          !Number.isFinite(point.longitude) ||
          Math.abs(point.latitude) > 90 ||
          Math.abs(point.longitude) > 180
        )
          throw unavailable('The map provider returned invalid coordinates')
        return point
      } catch (error) {
        if (error instanceof TypeError)
          throw unavailable('Map lookup is unavailable')
        throw error
      }
    },
    async autocomplete(query, session) {
      let result: ReturnType<typeof predictions>
      try {
        result = predictions(
          await request(
            '/v1/places:autocomplete',
            'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
            {
              input: query,
              sessionToken: session,
              includedPrimaryTypes: ['(cities)'],
              languageCode: 'en'
            }
          )
        )
      } catch (error) {
        if (error instanceof TypeError)
          throw unavailable('City lookup is unavailable')
        throw error
      }
      return result.suggestions
        .flatMap(row =>
          row.placePrediction == null
            ? []
            : [
                {
                  id: `google:${row.placePrediction.placeId}`,
                  primary: row.placePrediction.structuredFormat.mainText.text,
                  secondary:
                    row.placePrediction.structuredFormat.secondaryText?.text ??
                    ''
                }
              ]
        )
        .slice(0, 8)
    },
    async locality(id, session) {
      let result: ReturnType<typeof details>
      try {
        result = details(
          await request(
            `/v1/places/${encodeURIComponent(id)}?languageCode=en${session == null ? '' : '&sessionToken=' + encodeURIComponent(session)}`,
            'addressComponents,location'
          )
        )
      } catch (error) {
        if (error instanceof TypeError)
          throw unavailable('City lookup is unavailable')
        throw error
      }
      const component = (type: string): string | undefined =>
        result.addressComponents.find(row => row.types.includes(type))?.longText
      const city =
        component('locality') ??
        component('postal_town') ??
        component('administrative_area_level_3')
      const country = component('country')
      if (city == null || country == null)
        throw invalidLocation('Choose a city')
      const timezone = await coordinateTimezone(
        result.location.latitude,
        result.location.longitude,
        { apiKey, baseUrl: timeZoneBaseUrl, timeoutMs }
      )
      return asLocality({
        city,
        country,
        region: component('administrative_area_level_1') ?? country,
        placeId: `google:${id}`,
        timezone
      })
    }
  }
}
