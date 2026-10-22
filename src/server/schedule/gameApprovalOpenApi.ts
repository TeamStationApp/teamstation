import { eventLocationProperties } from '../events/eventInfoOpenApi'
export function gameApprovalPaths(
  errorResponse: unknown
): Record<string, unknown> {
  const responses = {
    200: { description: 'Current game scheduling or approval state' },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
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
  const paths: Record<string, unknown> = {
    '/game-requests': {
      post: {
        summary: 'Propose a new game or immutable material scheduling revision',
        security: [{ bearer: [] }],
        description:
          'An edit sender must administer an original or proposed participant. A direct or inherited hosting-season administrator may supply both team approvals when both proposed teams have active participation in that hosting season. Participation grants no general team management rights; visiting teams, inactive memberships and outside-season games keep their existing team approval requirements. Current roles and memberships are rechecked before publication. A hosting season administrator may also initiate a new game between visiting teams, contributing only team approvals they actually hold. Only the proposed home and away teams approve; inherited and placeholder-custodian authority counts. No separate hosting-season consent is required. Host-only authority cannot initiate edits to an accepted game. A submitted replacement of an unmanaged original team cancels the original event and reserves a distinct replacement ID; otherwise approved fields stay unchanged until consent. Retries preserve the same identities. Outside games keep seasonId null. Exhibition classification and timezone are independent of team identity.',
        requestBody: jsonBody({
          type: 'object',
          required: ['sender', 'game', 'idempotencyKey'],
          properties: {
            sender: {
              type: 'object',
              required: ['kind', 'id'],
              properties: {
                kind: { type: 'string', enum: ['team', 'season'] },
                id: { type: 'string' }
              }
            },
            game: {
              type: 'object',
              required: ['homeTeamId', 'awayTeamId', 'seasonId', 'startAt'],
              properties: {
                ...eventLocationProperties,
                homeTeamId: { type: 'string' },
                awayTeamId: { type: 'string' },
                seasonId: { type: ['string', 'null'] },
                startAt: { type: 'string', format: 'date-time' },
                venue: { type: ['string', 'null'] },
                outsideTournament: { type: ['string', 'null'] },
                fieldId: {
                  type: ['string', 'null'],
                  description:
                    'A registry field. Left out, an edit keeps the game’s field; null clears it. Setting one copies its venue, address and pin onto the game.'
                },
                fieldSize: {
                  type: ['string', 'null'],
                  enum: ['46/60', '50/70', '55/80', '60/90', null],
                  description:
                    'The size the field is set up in; its only size when left out.'
                },
                status: { type: 'string', enum: ['scheduled', 'cancelled'] },
                exhibition: { type: 'boolean', default: false },
                timezone: {
                  type: 'string',
                  description:
                    'IANA display timezone; defaults to hosting season or UTC on creation.'
                }
              }
            },
            gameId: { type: 'string' },
            expected: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            initiatingTeamId: { type: 'string' },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 }
          }
        }),
        responses: {
          ...responses,
          201: {
            description: 'One shared proposal and its current status/game ID'
          }
        }
      },
      get: {
        summary: 'Private pending or sender-declined schedule projections',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'scopeKind',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['team', 'season'] }
          },
          {
            name: 'scopeId',
            in: 'query',
            required: true,
            schema: { type: 'string' }
          }
        ],
        description:
          'Schedules mark unexpired pending proposals as Pending approval. New proposals reserve an event ID without publishing into scoring/media. Only the sender keeps a declined entry; deleting it preserves audit and every published game.',
        responses
      }
    },
    '/game-requests/{id}/schedule-entry': {
      delete: {
        summary: 'Hide only the selected inviting schedule declined projection',
        security: [{ bearer: [] }],
        parameters: [
          pathId('id'),
          {
            name: 'scopeKind',
            in: 'query',
            schema: { type: 'string', enum: ['season', 'team'] },
            description:
              'Defaults to the original sending scope when omitted with scopeId.'
          },
          {
            name: 'scopeId',
            in: 'query',
            schema: { type: 'string' },
            description:
              'The original sender or initiating team; current administration of this scope is required.'
          }
        ],
        responses
      }
    },
    '/games/{gameId}/scheduling': {
      get: {
        summary:
          'Current material scheduling version and effective change/withdraw capabilities',
        security: [{ bearer: [] }],
        parameters: [pathId('gameId')],
        responses
      }
    },
    '/games/{gameId}/withdrawals': {
      post: {
        summary:
          'A current team admin withdraws that team at any time, including after final result',
        security: [{ bearer: [] }],
        parameters: [pathId('gameId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['teamId'],
          properties: { teamId: { type: 'string' } }
        }),
        description:
          'Keeps the game ID, both team and host schedules, score, plays and media. Sets canceled/withdrawal with first committing team, user and timestamp, and closes pending revisions. No opposing/host consent. No automatic resurrection.',
        responses
      }
    }
  }
  for (const action of ['accept', 'decline', 'withdraw', 'resend'])
    paths[`/game-requests/{id}/${action}`] = {
      post: {
        summary: `${action} a shared seven-day game proposal`,
        security: [{ bearer: [] }],
        parameters: [pathId('id')],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 }
          }
        }),
        responses: {
          ...responses,
          ...(action === 'resend'
            ? {
                201: {
                  description:
                    'New terms/deadline with old request atomically closed'
                }
              }
            : {})
        }
      }
    }
  return paths
}
