import { FIELD_SIZES } from '../../common/venues'

/** The venue registry's paths, merged into `openApiDocument`. */
export function venuePaths(errorResponse: unknown): Record<string, unknown> {
  const errors = {
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    415: errorResponse,
    503: errorResponse
  }
  const pathId = (name: string): unknown => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' }
  })
  const jsonBody = (schema: unknown): unknown => ({
    required: true,
    content: { 'application/json': { schema } }
  })
  const weeklyHours = {
    type: 'array',
    description:
      'At most one range per weekday (0 is Sunday); times are HH:MM on 5-minute steps, in the venue’s time zone, and an end may be 24:00.',
    items: {
      type: 'object',
      required: ['weekday', 'start', 'end'],
      properties: {
        weekday: { type: 'integer', minimum: 0, maximum: 6 },
        start: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }
      }
    }
  }
  const dates = {
    type: 'array',
    items: { type: 'string', format: 'date' },
    maxItems: 366
  }
  const photo = {
    type: 'object',
    required: ['contentType', 'base64'],
    description:
      'A JPEG, PNG or WebP of at most 10 MiB; stored 16:9 at 640 and 1280 wide.',
    properties: {
      contentType: {
        type: 'string',
        enum: ['image/jpeg', 'image/png', 'image/webp']
      },
      base64: { type: 'string' }
    }
  }
  const sizes = {
    type: 'array',
    minItems: 1,
    items: { type: 'string', enum: [...FIELD_SIZES] }
  }
  const field = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 100 },
      sizes,
      pin: {
        type: ['object', 'null'],
        properties: {
          latitude: { type: 'number' },
          longitude: { type: 'number' }
        }
      },
      startsOn: { type: ['string', 'null'], format: 'date' },
      endsOn: { type: ['string', 'null'], format: 'date' },
      hours: {
        ...weeklyHours,
        type: ['array', 'null'],
        description: 'Null uses the venue’s default hours.'
      },
      blackouts: dates,
      photo
    }
  }
  const detail = {
    200: { description: 'The venue: fields, owners, claims, rights and map' },
    ...errors
  }
  const created = {
    201: { description: 'The venue: fields, owners, claims, rights and map' },
    ...errors
  }
  return {
    '/venues': {
      get: {
        summary: 'List or search venues',
        security: [{ bearer: [] }],
        description:
          'With league, the venues those leagues own or are claiming. Without query: the caller’s leagues’ venues, then other claimed venues, nearest to near first. With query: matches the caller’s leagues own, then claimed, then unclaimed, then Google places not yet in the registry (id null). With place, the one venue for that Google place: the registry’s, or the place itself with id null; each item is then a full venue.',
        parameters: [
          {
            name: 'query',
            in: 'query',
            schema: { type: 'string' },
            description: 'A name or address to search for; omitted lists.'
          },
          {
            name: 'near',
            in: 'query',
            schema: { type: 'string' },
            description:
              'latitude,longitude to sort by distance; omitted sorts by name.'
          },
          {
            name: 'league',
            in: 'query',
            schema: { type: 'array', items: { type: 'string' } },
            description: 'Repeatable; omitted applies no league filter.'
          },
          {
            name: 'place',
            in: 'query',
            schema: { type: 'string' },
            description:
              'A Google place id, asked for alone; omitted lists venues.'
          }
        ],
        responses: {
          200: { description: '{ items }: venue summaries, or full venues' },
          ...errors
        }
      },
      post: {
        summary: 'Add a Google place to the registry and claim it',
        security: [{ bearer: [] }],
        description:
          'The caller must administer the league. The claim waits seven days for a site administrator, or becomes a request to co-own when the venue is already claimed.',
        requestBody: jsonBody({
          type: 'object',
          required: ['placeId', 'leagueId'],
          properties: {
            placeId: { type: 'string' },
            leagueId: { type: 'string' }
          }
        }),
        responses: created
      }
    },
    '/venues/{venueId}': {
      get: {
        summary: 'Read a venue',
        security: [{ bearer: [] }],
        parameters: [pathId('venueId')],
        responses: detail
      },
      put: {
        summary: 'Change a venue',
        security: [{ bearer: [] }],
        description:
          'For an owning league’s admin, a site administrator, or the league holding the first pending claim. Missing keys keep their values.',
        parameters: [pathId('venueId')],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 200 },
            sizeSwitchMinutes: { type: 'integer', minimum: 0, maximum: 240 },
            defaultHours: weeklyHours,
            defaultBlackouts: dates,
            photo
          }
        }),
        responses: detail
      }
    },
    '/venues/{venueId}/claims': {
      post: {
        summary: 'Claim a venue, or ask to co-own it',
        security: [{ bearer: [] }],
        parameters: [pathId('venueId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['leagueId'],
          properties: { leagueId: { type: 'string' } }
        }),
        responses: created
      }
    },
    '/venues/{venueId}/claims/{claimId}/decisions': {
      post: {
        summary: 'Approve or reject a claim or request to co-own',
        security: [{ bearer: [] }],
        description:
          'A first claim is decided by a site administrator; a request to co-own by one, or by an owning league’s admin.',
        parameters: [pathId('venueId'), pathId('claimId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject'] }
          }
        }),
        responses: detail
      }
    },
    '/venues/{venueId}/claims/{claimId}': {
      delete: {
        summary: 'Leave, withdraw or remove a claim',
        security: [{ bearer: [] }],
        description:
          'The league’s admin leaves; a site administrator removes. The venue is unclaimed once no claim counts, and keeps its fields.',
        parameters: [pathId('venueId'), pathId('claimId')],
        responses: detail
      }
    },
    '/venues/{venueId}/fields': {
      post: {
        summary: 'Add a field',
        security: [{ bearer: [] }],
        parameters: [pathId('venueId')],
        requestBody: jsonBody({ ...field, required: ['name', 'sizes'] }),
        responses: created
      }
    },
    '/venues/{venueId}/fields/{fieldId}': {
      put: {
        summary: 'Change a field',
        security: [{ bearer: [] }],
        description: 'Missing keys keep their values.',
        parameters: [pathId('venueId'), pathId('fieldId')],
        requestBody: jsonBody(field),
        responses: detail
      },
      delete: {
        summary: 'Delete a field',
        security: [{ bearer: [] }],
        description:
          'Games on the field stay; upcoming ones are warned that the field was deleted.',
        parameters: [pathId('venueId'), pathId('fieldId')],
        responses: detail
      }
    }
  }
}
