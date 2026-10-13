import { asArray, asNumber, asObject, asString } from 'cleaners'

import { invalidLocation, notFound, unavailable } from '../../common/errors'
import {
  asLocality,
  type CitySuggestion,
  type Locality
} from '../../common/locality'
import { coordinateTimezone } from './coordinateTimezone'

export interface GooglePlaces {
  autocomplete: (query: string, session: string) => Promise<CitySuggestion[]>
  locality: (id: string, session?: string) => Promise<Locality>
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
