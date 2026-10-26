/** The Auto-Scheduler preview paths, merged into `openApiDocument`. */
export function schedulePreviewPaths(
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
  const preview = {
    description:
      'The preview: id, leagueId, mode, existing, status (open, published, discarded), options (games, fairness, reasons, unmet), blocking, edits, replacing, publishedOption, publishedAt, published (each published game’s state), teams, seasons and fields, each field with its timezone, the zone its games are placed and read in'
  }
  const addedGame = {
    type: 'object',
    required: [
      'seasonId',
      'homeTeamId',
      'awayTeamId',
      'fieldId',
      'size',
      'startAt',
      'endAt'
    ],
    properties: {
      seasonId: { type: 'string' },
      homeTeamId: { type: 'string' },
      awayTeamId: { type: 'string' },
      exhibition: { type: 'boolean' },
      fieldId: { type: 'string' },
      size: { type: 'string', enum: ['46/60', '50/70', '55/80', '60/90'] },
      startAt: { type: 'string', format: 'date-time' },
      endAt: { type: 'string', format: 'date-time' }
    }
  }
  return {
    '/leagues/{leagueId}/schedule-previews': {
      post: {
        summary: 'Build a preview of the league’s schedule',
        security: [{ bearer: [] }],
        description:
          'For a league admin, from the league’s chosen seasons and fields. A full build of seasons that already have upcoming games answers 409 with details.existingGames until existing says whether to replace or work around them. A partial build places only teamIds’ games again, replacing theirs. fromPreviewId and option recalculate an open preview: its option’s games but the rejected ones, and the added games, stay, and the old preview is discarded. Up to three options; with blocking set there are none.',
        parameters: [pathId('leagueId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['full', 'partial'] },
            existing: { type: 'string', enum: ['replace', 'workAround'] },
            teamIds: { type: 'array', items: { type: 'string' } },
            fromPreviewId: { type: 'string' },
            option: { type: 'integer', minimum: 0, maximum: 2 }
          }
        }),
        responses: { 201: preview, ...errors }
      }
    },
    '/leagues/{leagueId}/games-to-reschedule': {
      get: {
        summary: 'List the league’s published games that need rescheduling',
        security: [{ bearer: [] }],
        description:
          'For a league admin: games the Auto-Scheduler published that were declined, withdrawn, not answered in time, canceled or rejected, and not yet placed again.',
        parameters: [pathId('leagueId')],
        responses: {
          200: {
            description:
              '{ items }: previewId, gameKey, gameId, seasonId, the teams, startAt, timezone and reason'
          },
          ...errors
        }
      }
    },
    '/schedule-previews/{previewId}': {
      get: {
        summary: 'Read a schedule preview',
        security: [{ bearer: [] }],
        description: 'For an admin of the preview’s league.',
        parameters: [pathId('previewId')],
        responses: { 200: preview, ...errors }
      },
      put: {
        summary: 'Reject and add games of one option',
        security: [{ bearer: [] }],
        description:
          'On an open preview, records the edits against the option: rejected games are left out, and added games, checked against the hard rules, join it. On a published preview both act at once: rejected games come off the schedules or have their proposals withdrawn, and added games are proposed.',
        parameters: [pathId('previewId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['option'],
          properties: {
            option: { type: 'integer', minimum: 0, maximum: 2 },
            rejectedGameKeys: { type: 'array', items: { type: 'string' } },
            addedGames: { type: 'array', maxItems: 50, items: addedGame }
          }
        }),
        responses: { 200: preview, ...errors }
      }
    },
    '/schedule-previews/{previewId}/publications': {
      post: {
        summary: 'Publish one option of a preview',
        security: [{ bearer: [] }],
        description:
          'Once per preview; a retry answers with what was published. Rechecks every game first and answers 409 with details.stale when something changed. With Replace, the replaced games are canceled as rescheduled. Each game is proposed as its season through the usual approval rules, which decide whether it is scheduled at once or waits for a team’s approval.',
        parameters: [pathId('previewId')],
        requestBody: jsonBody({
          type: 'object',
          required: ['option'],
          properties: { option: { type: 'integer', minimum: 0, maximum: 2 } }
        }),
        responses: {
          200: {
            description:
              '{ preview, scheduled, awaiting, removed }: the published preview and its counts'
          },
          ...errors
        }
      }
    }
  }
}
