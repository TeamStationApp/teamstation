import { MAX_PLAN_INNINGS, PLAN_CELLS } from '../../common/gamePlan'
import { playingTimeRulesSchema } from '../groups/openApi'
import { nullableGumboIdSchema } from '../userIdSchema'

const counts = (description: string): Record<string, unknown> => ({
  type: 'object',
  description,
  additionalProperties: { type: 'integer', minimum: 0 }
})
const flags = (description: string): Record<string, unknown> => ({
  type: 'object',
  description,
  additionalProperties: { type: 'boolean', enum: [true] }
})

/** A coach's per-inning plan for one side, as it is saved and answered. */
const gamePlan = {
  type: 'object',
  required: ['enabled', 'innings', 'rows'],
  properties: {
    enabled: {
      type: 'boolean',
      description:
        "Whether the scorekeeper's game moves the side's defence to the next inning's column at each inning's end. The server stores whether any cell holds a field position, whatever is sent"
    },
    innings: { type: 'integer', minimum: 1, maximum: MAX_PLAN_INNINGS },
    rows: {
      type: 'array',
      description: 'One per batter, in batting order',
      items: {
        type: 'object',
        required: ['player', 'cells'],
        properties: {
          player: {
            type: 'object',
            required: ['gumboId', 'fullName', 'jersey'],
            properties: {
              gumboId: nullableGumboIdSchema,
              fullName: { type: 'string' },
              jersey: { type: 'string' }
            }
          },
          cells: {
            type: 'array',
            description:
              'Exactly one per inning: a field position, DH or EH (bats without fielding), or blank (sits). An inning whose column holds no field position is not planned yet. A - from an older client is read as blank',
            items: { type: 'string', enum: [...PLAN_CELLS, ''] }
          }
        }
      }
    }
  }
}

/** One side's plan, with what its playing-time warnings are judged by. */
const sidePlan = {
  type: 'object',
  required: ['teamId', 'plan', 'rules', 'sameDay'],
  properties: {
    teamId: { type: 'string' },
    plan: {
      ...gamePlan,
      type: ['object', 'null'],
      description: 'Null before a save'
    },
    rules: {
      ...playingTimeRulesSchema,
      description:
        "The Playing Time Rules the plan is judged by: the team's own; else those of the game's season; else those of the latest-starting managing season with rules; else null"
    },
    sameDay: {
      type: 'object',
      description:
        "The team's plans in its other games on this game's date, in the game's time zone, by player key (`g:<gumboId>`, or `n:<fullName>#<jersey>` for a player made up at the field), split at this game (a game at the same start time is earlier when its id sorts first)",
      required: ['before', 'laterPitched'],
      properties: {
        before: {
          type: 'object',
          description: 'The games that start before this one',
          required: ['catcherInnings'],
          properties: { catcherInnings: counts('Innings caught') }
        },
        laterPitched: flags('Pitches in a game that starts after this one')
      }
    }
  }
}

export function gamePlanPaths(errorResponse: unknown): Record<string, unknown> {
  const gameId = {
    name: 'gameId',
    in: 'path',
    required: true,
    schema: { type: 'string' }
  }
  return {
    '/games/{gameId}/plans': {
      get: {
        summary: "Both sides' per-inning game plans",
        description:
          "Needs somebody who can see the game; 404 for anybody else. A side is answered only to whoever may save its lineup (the team's head coach, or a scorekeeper of either team), and is null for anybody else.",
        security: [{ bearer: [] }],
        parameters: [gameId],
        responses: {
          200: {
            description: '{ away, home }',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['away', 'home'],
                  properties: {
                    away: { ...sidePlan, type: ['object', 'null'] },
                    home: { ...sidePlan, type: ['object', 'null'] }
                  }
                }
              }
            }
          },
          401: errorResponse,
          404: errorResponse
        }
      }
    },
    '/games/{gameId}/plans/{teamId}': {
      put: {
        summary: "Save one team's per-inning game plan",
        description:
          "Replaces the team's plan in the game, as whoever may save its lineup. A plan with a cell that is no value, more than twelve innings, or a row whose cells are not one per inning is a 400. An all-blank plan is stored like any other. The game's viewers hear a `plans` change naming only the team.",
        security: [{ bearer: [] }],
        parameters: [
          gameId,
          {
            name: 'teamId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: gamePlan } }
        },
        responses: {
          200: {
            description: 'The side as saved',
            content: { 'application/json': { schema: sidePlan } }
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse
        }
      }
    }
  }
}
