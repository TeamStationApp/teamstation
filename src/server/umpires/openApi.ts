export function umpirePaths(errorResponse: unknown): Record<string, unknown> {
  const settings = {
    type: 'object',
    properties: {
      management: { type: 'boolean' },
      credits: { type: 'boolean' }
    }
  }
  const parameters = [
    { name: 'leagueId', in: 'path', required: true, schema: { type: 'string' } }
  ]
  const responses = {
    200: {
      description: 'League umpire settings',
      content: { 'application/json': { schema: settings } }
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse
  }
  const paths: Record<string, unknown> = {
    '/leagues/{leagueId}/umpire-settings': {
      get: {
        summary: 'Read league umpire settings as an administrator',
        security: [{ bearer: [] }],
        parameters,
        responses
      },
      put: {
        summary: 'Update umpire settings, preserving roles and assignments',
        security: [{ bearer: [] }],
        parameters,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: settings } }
        },
        responses
      }
    }
  }
  paths['/games/{gameId}/umpire-notes/{typeId}'] = {
    put: {
      summary:
        'Save one custom umpire note as a league administrator; blank clears it and stale edits conflict',
      security: [{ bearer: [] }],
      parameters: ['gameId', 'typeId'].map(name => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' }
      })),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['before', 'value'],
              properties: {
                before: { type: 'string', maxLength: 2000 },
                value: { type: 'string', maxLength: 2000 }
              }
            }
          }
        }
      },
      responses: {
        ...responses,
        200: {
          description: 'Persisted value',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { value: { type: 'string' } }
              }
            }
          }
        },
        409: errorResponse
      }
    }
  }
  for (const [path, methods, summary] of [
    [
      '/leagues/{leagueId}/umpire-note-types',
      ['get', 'post'],
      'List or add custom umpire game note types'
    ],
    [
      '/leagues/{leagueId}/umpire-note-types/{typeId}',
      ['delete'],
      'Remove a note type and its game values'
    ],
    [
      '/leagues/{leagueId}/umpire-types',
      ['get', 'post'],
      'List or add league umpire types'
    ],
    [
      '/leagues/{leagueId}/umpire-types/{typeId}',
      ['delete'],
      'Remove type requirements, certifications, assignments and their credits'
    ],
    [
      '/leagues/{leagueId}/umpire-levels',
      ['get', 'post'],
      'List or add league umpire levels'
    ],
    [
      '/leagues/{leagueId}/umpire-levels/{levelId}',
      ['delete'],
      'Remove a level and its requirements, certifications and assignments'
    ],
    [
      '/leagues/{leagueId}/umpire-requirements',
      ['get', 'put'],
      'Read or replace current and upcoming season umpire requirements'
    ],
    [
      '/leagues/{leagueId}/umpire-candidates',
      ['get'],
      'Find affiliated people who do not hold the umpire role'
    ],
    [
      '/leagues/{leagueId}/umpires',
      ['get', 'post', 'put'],
      'List or grant independent league umpire roles'
    ],
    [
      '/leagues/{leagueId}/umpires/{userId}',
      ['delete'],
      'Revoke a role and non-final assignments, preserving certifications'
    ],
    [
      '/leagues/{leagueId}/umpires/{userId}/certifications',
      ['put'],
      'Set a level and type certification'
    ]
  ] as const) {
    const parameters: unknown[] = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' }
    }))
    if (path.endsWith('umpire-candidates'))
      parameters.push({
        name: 'q',
        in: 'query',
        description:
          'Case-insensitive name substring; empty returns no people.',
        schema: { type: 'string', default: '' }
      })
    paths[path] = Object.fromEntries(
      methods.map(method => [
        method,
        {
          summary,
          security: [{ bearer: [] }],
          parameters,
          responses: {
            ...responses,
            200: { description: 'Requested umpire resource' }
          },
          ...(method === 'post' || method === 'put'
            ? {
                requestBody: {
                  required: true,
                  content: {
                    'application/json': { schema: { type: 'object' } }
                  }
                }
              }
            : {})
        }
      ])
    )
  }

  const umpireState = {
    type: 'object',
    nullable: true,
    required: ['certifications'],
    properties: {
      certifications: {
        type: 'array',
        maxItems: 10000,
        items: {
          type: 'object',
          required: ['levelId', 'typeId', 'enabled'],
          properties: {
            levelId: { type: 'string' },
            typeId: { type: 'string' },
            enabled: { type: 'boolean' }
          }
        }
      }
    }
  }
  const collection = paths['/leagues/{leagueId}/umpires'] as Record<
    string,
    Record<string, unknown>
  >
  collection.put = {
    summary: 'Atomically save changed umpire memberships and certifications',
    description:
      'Only changed canonical people are submitted. Null states mean no umpire role. Before must match current effective permissions; a current state equal to after is an idempotent retry. Unrelated people remain unchanged. A stale changed person returns 409 with no writes. Revokes remove non-final assignments.',
    security: [{ bearer: [] }],
    parameters,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['changes'],
            properties: {
              changes: {
                type: 'array',
                maxItems: 500,
                items: {
                  type: 'object',
                  required: ['userId', 'before', 'after'],
                  properties: {
                    userId: { type: 'string' },
                    before: umpireState,
                    after: umpireState
                  }
                }
              }
            }
          }
        }
      }
    },
    responses: {
      ...responses,
      200: {
        description: 'Current people and certifications, in a people array'
      },
      409: errorResponse
    }
  }

  const requirementsPath = paths[
    '/leagues/{leagueId}/umpire-requirements'
  ] as Record<string, Record<string, unknown>>
  requirementsPath.put.requestBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['seasonIds', 'levelId', 'types'],
          properties: {
            seasonIds: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' }
            },
            levelId: { type: 'string' },
            types: {
              type: 'array',
              items: {
                type: 'object',
                required: ['typeId', 'required', 'optional'],
                properties: {
                  typeId: { type: 'string' },
                  required: { type: 'integer', minimum: 0, maximum: 6 },
                  optional: { type: 'integer', minimum: 0, maximum: 6 }
                }
              }
            }
          }
        }
      }
    }
  }

  paths['/me/umpire-leagues'] = {
    get: {
      summary: 'Managed leagues where the caller holds an explicit umpire role',
      security: [{ bearer: [] }],
      responses: {
        ...responses,
        200: { description: 'Accessible umpire leagues' }
      }
    }
  }
  paths['/leagues/{leagueId}/umpire-schedule'] = {
    get: {
      summary: 'Umpire schedule with availability and conflicts',
      security: [{ bearer: [] }],
      parameters: [
        ...parameters,
        {
          name: 'view',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['umpire', 'league', 'schedule'],
            default: 'umpire'
          },
          description:
            'Legacy umpire involvement or administrator league view; schedule admits league admins and umpires and defaults to seasons whose end date has not passed in the season timezone'
        },
        {
          name: 'paged',
          in: 'query',
          schema: { type: 'string', enum: ['1', 'true'] },
          description:
            'Answer the schedule with `{items, nextCursor, prevCursor, anchorId, counts, positions}` in place of `games`, soonest first. `counts` is null. Not with view=league'
        },
        {
          name: 'cursor',
          in: 'query',
          schema: { type: 'string' },
          description:
            'A `nextCursor` or `prevCursor`, with the filters of the query that gave it. Needs `paged`. A malformed one is a 400'
        },
        {
          name: 'around',
          in: 'query',
          schema: { type: 'string', enum: ['next'] },
          description:
            '`next` opens a first page on the game the table opens on, the first under way or still to start, with rows before it. Needs `paged`, and does not take `cursor`'
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          description: 'Page size. Only with `paged`'
        },
        {
          name: 'priorSeasons',
          in: 'query',
          schema: { type: 'boolean', default: false },
          description:
            'Requires view=schedule. Only league administrators may enable this to include ended seasons; false retains current and upcoming seasons'
        },
        {
          name: 'timezone',
          in: 'query',
          schema: { type: 'string' },
          description:
            'Viewer IANA timezone for displayed dates and day/time filters; omitted uses each game timezone'
        },
        ...['levels', 'days', 'from', 'to'].map(name => ({
          name,
          in: 'query',
          ...(name === 'days' || name === 'levels'
            ? {
                style: 'form',
                explode: true,
                schema: { type: 'array', items: { type: 'string' } }
              }
            : { schema: { type: 'string', default: '' } }),
          description:
            name === 'days'
              ? 'Repeated weekdays, Monday 0 to Sunday 6; empty means all'
              : name === 'levels'
                ? 'Repeated level IDs with unfilled required umpire positions; optional vacancies do not qualify; empty means all'
                : 'Requested-timezone HH:mm (game-local when omitted); filtering requires both endpoints, with to after from'
        }))
      ],
      responses: {
        ...responses,
        200: {
          description:
            'Visible games, slot choices and credit teams. With `paged`, one page of those games, and `positions`: the position columns of the whole filtered list, each with its `optionalHeader`, `Optional`, `Optional in some games` or null'
        }
      }
    }
  }

  const slotSchema = {
    type: 'object',
    properties: {
      slot: { type: 'string', pattern: '^[^:]+:([1-9]|1[0-2])$' },
      userId: { type: 'string' },
      creditTeamId: { type: ['string', 'null'] }
    }
  }
  paths['/games/{gameId}/umpire-slots'] = Object.fromEntries(
    ['post', 'delete'].map(method => [
      method,
      {
        summary:
          method === 'post'
            ? 'Fill an eligible umpire slot and optionally credit a team'
            : 'Remove an assignment, enforcing the self-removal cutoff',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'gameId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                ...slotSchema,
                required: method === 'post' ? ['slot', 'userId'] : ['slot']
              }
            }
          }
        },
        responses: {
          ...responses,
          200: { description: 'Assignment saved or removed' },
          409: errorResponse
        }
      }
    ])
  )
  paths['/leagues/{leagueId}/umpire-leaderboard'] = {
    get: {
      summary:
        'Top ten completed and scheduled umpires and optional team credits',
      security: [{ bearer: [] }],
      parameters,
      responses: {
        ...responses,
        200: {
          description:
            'Completed and scheduled people rankings and team credits'
        }
      }
    }
  }
  return paths
}
