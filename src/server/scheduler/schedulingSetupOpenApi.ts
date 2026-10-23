/** The Auto-Scheduler setup's paths, merged into `openApiDocument`. */
export function schedulingSetupPaths(
  errorResponse: unknown
): Record<string, unknown> {
  const errors = {
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse
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
      'At most one range per weekday (0 is Sunday); times are HH:MM on 5-minute steps, in the season’s time zone.',
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
  const settings = {
    type: 'object',
    required: [
      'fieldSize',
      'gameMinutes',
      'bufferMinutes',
      'regularGames',
      'exhibitionGames',
      'doubleheaders',
      'startsOn',
      'endsOn'
    ],
    properties: {
      fieldSize: { type: 'string', enum: ['46/60', '50/70', '55/80', '60/90'] },
      gameMinutes: {
        type: 'integer',
        minimum: 30,
        maximum: 600,
        multipleOf: 5
      },
      bufferMinutes: {
        type: 'integer',
        minimum: 0,
        maximum: 240,
        multipleOf: 5
      },
      regularGames: { type: 'integer', minimum: 0, maximum: 200 },
      exhibitionGames: { type: 'integer', minimum: 0, maximum: 200 },
      doubleheaders: {
        type: 'string',
        enum: ['never', 'ifNecessary', 'allowed']
      },
      startsOn: { type: 'string', format: 'date' },
      endsOn: { type: 'string', format: 'date' },
      blackouts: {
        type: 'array',
        items: { type: 'string', format: 'date' },
        maxItems: 366
      },
      windows: {
        type: 'array',
        maxItems: 20,
        description:
          'Periods of weekly game windows, one per from date; each is in force from its date until the next.',
        items: {
          type: 'object',
          required: ['from', 'hours'],
          properties: {
            from: { type: 'string', format: 'date' },
            hours: weeklyHours
          }
        }
      }
    }
  }
  const setup = {
    200: {
      description:
        '{ leagueId, seasonIds, fieldIds, seasons, fields }: the chosen seasons and fields, every season of the league with its settings and team counts, and the fields of the league’s venues and any other chosen field'
    },
    ...errors
  }
  const seasonSettings = {
    200: {
      description:
        '{ seasonId, saved, timezone, settings }: saved is false while the season reads as defaults; timezone is the season’s zone, after any zone the save adopted'
    },
    ...errors
  }
  return {
    '/seasons/{seasonId}/schedule-settings': {
      get: {
        summary: 'Read a season’s scheduling settings',
        security: [{ bearer: [] }],
        description:
          'For an admin of the season’s league; 409 for a season with no league. A season never set up reads as its own dates, 120-minute games, a 15-minute buffer, no games, doubleheaders only if necessary, and no windows.',
        parameters: [pathId('seasonId')],
        responses: seasonSettings
      },
      put: {
        summary: 'Replace a season’s scheduling settings',
        security: [{ bearer: [] }],
        description:
          'For an admin of the season’s league. With timezone, the zone the settings were set up in, a season still at the UTC default adopts it, and its pending participation and parent requests are superseded; a season with another zone keeps it.',
        parameters: [pathId('seasonId')],
        requestBody: jsonBody({
          ...settings,
          properties: {
            ...settings.properties,
            timezone: {
              type: 'string',
              description: 'An IANA time zone, such as America/Los_Angeles'
            }
          }
        }),
        responses: seasonSettings
      }
    },
    '/leagues/{leagueId}/schedule-setup': {
      get: {
        summary: 'Read the league’s Auto-Scheduler setup',
        security: [{ bearer: [] }],
        description: 'For a league admin.',
        parameters: [pathId('leagueId')],
        responses: setup
      },
      put: {
        summary: 'Choose the seasons and fields of the league’s next schedule',
        security: [{ bearer: [] }],
        description:
          'For a league admin. Seasons must belong to the league; fields must be fields, not deleted, of claimed venues.',
        parameters: [pathId('leagueId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['seasonIds', 'fieldIds'],
          properties: {
            seasonIds: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string' }
            },
            fieldIds: {
              type: 'array',
              maxItems: 100,
              items: { type: 'string' }
            }
          }
        }),
        responses: setup
      }
    }
  }
}
