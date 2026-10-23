import { userIdSchema } from '../userIdSchema'
export const eventLocationProperties = {
  notes: { type: ['string', 'null'], maxLength: 2000 },
  arrivalTimeDelta: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 10080,
    description:
      'Minutes prior to start; null omits arrival. No default/backfill on stored events.'
  },
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
        'Event info: id, eventKind, eventType (game/practice/other), title, selected teamId/teamName, attendanceTeams {id,name,isParticipant}, startAt/endAt, arrivalTimeDelta, notes, timezone, venue/address/coordinates, status, canManage, replyUserIds and attendees {userId,name,avatarUrl,response,canReply,isTeamParticipant,isPlayer,staffRoles,bats,throws,positions,guardianOf}. isParticipant marks the viewer’s direct team or guardian-of-player affiliation; inherited visibility alone does not show a team selector. Names and guardian names are abbreviated. Reply controls include only explicit members/admins/coaches of a participating team and their guardian-linked children who play on a participating roster; inherited access alone never grants a self reply. Eligible children on the other participating team remain private; public lists include only isTeamParticipant. No reply is null. A game linked to a registry field also has field {id, name, size, latitude, longitude}, at the field’s pin or, without one, its venue’s point, and named even once the field is deleted, and fieldWarnings {kind: conflict|outsideAvailability|fieldDeleted|sizeRemoved, message}, empty when nothing is wrong; only upcoming, scheduled games have any.'
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
        parameters: [
          ...parameters,
          {
            name: 'teamId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description:
              'One visible participating team, including merged aliases. Defaults to the viewer’s directly affiliated participating team with the most points: one each for guarding a player there, being on its staff and being a member, a tie going home first; otherwise visible home or the first visible participant. With none visible, only private family controls are returned. Attendance excludes inherited people and the opponent.'
          }
        ],
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
                  title: {
                    type: 'string',
                    maxLength: 200,
                    description:
                      'A practice cleared of its title is called `Practice` again. Any other event needs 1–200 characters. Turning a practice still called `Practice` into another event needs a new title (400 `Title is required`).'
                  },
                  startAt: { type: 'string', format: 'date-time' },
                  venue: { type: ['string', 'null'] },
                  eventType: { type: 'string', enum: ['practice', 'other'] },
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
          'Authorized saved-address lookup. A game linked to a registry field returns the field’s point and is never looked up. Otherwise an explicit address is used unchanged, falling back to a saved venue qualified by team locality. Explicit-address coordinates take precedence; an absent location returns null coordinates. Google Places is primary when configured, with Photon only on provider unavailability. Google lookups are limited per account, bounded, timeout-protected and deduplicated; Google coordinates are not cached indefinitely. No arbitrary address query is accepted.',
        responses: {
          ...responses,
          200: {
            description:
              '{ latitude, longitude, tileUrl, googleMapsApiKey? }. The optional key is the browser-restricted Google Maps display key, never a server or Android credential.'
          },
          503: errorResponse
        }
      }
    },
    '/events/{id}/rsvps/{userId}': {
      put: {
        summary: 'RSVP for oneself or a child',
        security: [{ bearer: [] }],
        description:
          'Only self or a current guardian-linked active child; administrator status gives no proxy RSVP power. Rechecked transactionally. No reply is absence; returning to center stores maybe.',
        parameters: [
          ...parameters,
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: userIdSchema
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
      'A full-team administrator creates an event with no opponent: a practice, which schedules call `Practice` and needs no title, or another event, which needs one. The retry key is unique per user; replay returns the same ID, different details conflict. Visible schedules include events; scoring/film/played/scoreboard/external-ID and video queries stay game-only.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['teamId', 'startAt', 'idempotencyKey'],
            properties: {
              ...eventLocationProperties,
              teamId: { type: 'string' },
              title: {
                type: 'string',
                maxLength: 200,
                description:
                  'Required (1–200 characters after trimming) unless `eventType` is `practice`. A practice sent with no title, or a blank one, is stored as `Practice`.'
              },
              startAt: { type: 'string', format: 'date-time' },
              timezone: { type: 'string', default: 'UTC' },
              venue: { type: ['string', 'null'], maxLength: 200 },
              eventType: {
                type: 'string',
                enum: ['practice', 'other'],
                default: 'other'
              },
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
