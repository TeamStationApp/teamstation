export const eventLocationProperties = {
  endAt: {
    type: ['string', 'null'],
    format: 'date-time',
    description: 'Scheduled end, after start.'
  },
  address: { type: ['string', 'null'], maxLength: 500 },
  latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
  longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 }
}

export function eventInfoPaths(
  errorResponse: unknown
): Record<string, unknown> {
  const parameters = [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
  ]
  const responses = {
    200: {
      description:
        'Event info: id, eventKind, title, teamId/teamName, startAt/endAt, timezone, venue/address/coordinates, status, canManage, replyUserIds and attendees {userId,name,avatarUrl,response,canReply}. No response is null.'
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse
  }
  return {
    '/events/{id}/info': {
      get: {
        summary: 'Event location and attendance',
        security: [{ bearer: [] }],
        parameters,
        responses
      },
      put: {
        summary: 'Edit event information',
        security: [{ bearer: [] }],
        parameters,
        description:
          'An administrator may edit game location/end; game time, venue, participants and status use game approval. Non-game events also permit title, time, venue, timezone and cancellation. Omitted fields keep their values. Changing address clears stale coordinates.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ...eventLocationProperties,
                  title: { type: 'string', minLength: 1, maxLength: 200 },
                  startAt: { type: 'string', format: 'date-time' },
                  venue: { type: ['string', 'null'] },
                  timezone: { type: 'string' },
                  status: { type: 'string', enum: ['scheduled', 'cancelled'] }
                }
              }
            }
          }
        },
        responses
      }
    },
    '/events/{id}/location': {
      get: {
        summary: 'Resolve an event address for its map',
        security: [{ bearer: [] }],
        parameters,
        description:
          'Authorized saved-address lookup. Saved coordinates or cached Photon geocode; absent address returns null coordinates. Lookup is bounded, timeout-protected and deduplicated. No arbitrary address query is accepted.',
        responses: {
          ...responses,
          200: { description: '{ latitude, longitude, tileUrl }' },
          503: errorResponse
        }
      }
    },
    '/events/{id}/rsvps/{userId}': {
      put: {
        summary: 'RSVP for oneself or a child',
        security: [{ bearer: [] }],
        description:
          'Only self or a current guardian-linked player on the event teams; administrator status gives no proxy RSVP power. Rechecked transactionally. No reply is absence; returning to center stores maybe.',
        parameters: [
          ...parameters,
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1 }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['response'],
                properties: {
                  response: { type: 'string', enum: ['yes', 'maybe', 'no'] }
                }
              }
            }
          }
        },
        responses: {
          ...responses,
          200: { description: '{ userId, response }' }
        }
      }
    }
  }
}

export function createEventOperation(errorResponse: unknown): unknown {
  return {
    summary: 'Schedule a titled non-game team event',
    security: [{ bearer: [] }],
    description:
      'A full-team administrator creates a title-based event with no opponent. The retry key is unique per user; replay returns the same ID, different details conflict. Visible schedules include events; scoring/film/played/scoreboard/external-ID and video queries stay game-only.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['teamId', 'title', 'startAt', 'idempotencyKey'],
            properties: {
              ...eventLocationProperties,
              teamId: { type: 'string' },
              title: { type: 'string', minLength: 1, maxLength: 200 },
              startAt: { type: 'string', format: 'date-time' },
              timezone: { type: 'string', default: 'UTC' },
              venue: { type: ['string', 'null'], maxLength: 200 },
              status: {
                type: 'string',
                enum: ['scheduled', 'cancelled'],
                default: 'scheduled'
              },
              idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 }
            }
          }
        }
      }
    },
    responses: {
      201: { description: '{ id }' },
      400: errorResponse,
      401: errorResponse,
      403: errorResponse,
      404: errorResponse,
      409: errorResponse
    }
  }
}
