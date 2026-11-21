import { UMPIRE_LEADERBOARD_MAX_PAGE } from '../../common/umpireSchedule'

/** A saved umpire availability filter, or null when none is saved. */
export const umpireAvailabilitySchema = {
  type: ['object', 'null'],
  required: ['levels', 'days', 'from', 'to', 'timezone'],
  description:
    'A saved umpire availability filter for one league, read in its own ' +
    '`timezone`: the umpire levels, the weekdays (0 is Monday … 6 is ' +
    'Sunday) and the `from`–`to` time of day (`HH:mm`, both ends ' +
    'inclusive). No levels or days means every one; no range means any ' +
    'time. Null when none is saved.',
  properties: {
    levels: { type: 'array', items: { type: 'string' } },
    days: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 }
    },
    from: { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    to: { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    timezone: { type: 'string', description: 'An IANA time zone.' }
  }
}

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
  // Each person is `{ id, name, avatarUrl, affiliations, certifications }`.
  for (const path of [
    '/leagues/{leagueId}/umpire-candidates',
    '/leagues/{leagueId}/umpires'
  ])
    (paths[path] as Record<string, Record<string, unknown>>).get.description =
      'Each of `people` is `{ id, name, avatarUrl, affiliations, ' +
      'certifications }`. `affiliations` is the line under the name: the ' +
      'guarded players, guardians and league teams the caller may see, ' +
      'named as the caller may read them, empty when none is visible.' +
      (path.endsWith('/umpires')
        ? ' On the umpire list each person also carries ' +
          '`umpireAvailability`, their saved filter for this league (null ' +
          'when none is saved). The availability parameters keep only the ' +
          'people whose saved filter leaves the time in: a filter matches ' +
          'on the start, read in its own time zone, as the umpire ' +
          'schedule\u2019s filter matches a game. Somebody with no saved ' +
          'filter counts as available unless `strict` is true. For a ' +
          'game, pass `availableAt`: one instant, read in each saved ' +
          'filter\u2019s zone. `day` and `time` are for a general weekly ' +
          'question: they are read as the wall-clock weekday and time of ' +
          'day in each umpire\u2019s own saved zone, so one `day` and ' +
          '`time` is a different instant for umpires in different zones. ' +
          'With ' +
          '`availableAt` the answer also carries `matchedAt`: for each time ' +
          'zone of the league\u2019s games starting then and of the saved ' +
          'filters (empty when there is neither), ' +
          '`{ timezone, weekday, date, time }`, ' +
          'the weekday (`Monday` … `Sunday`), date (`YYYY-MM-DD`) and time ' +
          'of day (`HH:mm`) the start was matched on there.'
        : '')
  const umpireList = paths['/leagues/{leagueId}/umpires'] as Record<
    string,
    Record<string, unknown>
  >
  umpireList.get.parameters = [
    ...parameters,
    {
      name: 'availableAt',
      in: 'query',
      schema: { type: 'string', format: 'date-time' },
      description:
        'A game start: keeps people whose saved filter has its weekday and ' +
        'time of day, read in the filter\u2019s time zone, within `from`–`to` ' +
        '(both ends inclusive). An ISO 8601 date-time with `Z` or an ' +
        'explicit offset; any other value is 400.'
    },
    {
      name: 'durationMinutes',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 1440 },
      description:
        'With `availableAt`: the game\u2019s end must also fall by `to` on ' +
        'the same local day.'
    },
    {
      name: 'day',
      in: 'query',
      schema: { type: 'integer', minimum: 0, maximum: 6 },
      description:
        'A weekday, 0 is Monday … 6 is Sunday; goes with `time`. Keeps ' +
        'people whose saved days include it (or who saved no days), read ' +
        'as the weekday in each umpire\u2019s own saved zone, not as one ' +
        'instant; for a game, use `availableAt`.'
    },
    {
      name: 'time',
      in: 'query',
      schema: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      description:
        'A time of day, `HH:mm`; goes with `day`. Keeps people whose saved ' +
        'range holds it (or who saved none), read as wall-clock time in ' +
        'each umpire\u2019s own saved zone; for a game, use `availableAt`.'
    },
    {
      name: 'level',
      in: 'query',
      schema: { type: 'string' },
      description:
        'An umpire level id: keeps people whose saved levels include it, ' +
        'or who saved none.'
    },
    {
      name: 'strict',
      in: 'query',
      schema: { type: 'boolean', default: false },
      description: 'Leaves out people with no saved filter.'
    }
  ]
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
  requirementsPath.get.description =
    'Each of `seasons` is `{ id, name, logoUrl, leagueId, leaguePictureUrl, ' +
    'requirement }`. `leaguePictureUrl` is the league\u2019s signed picture, ' +
    'or null, which a season with no `logoUrl` is drawn with.'
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
          schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          description:
            'Page size. Only with `paged`. Every page computes the whole schedule, so a page may hold up to 500 rows'
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
      summary: `Umpires ranked by completed and scheduled games, with team credits: the top ten, or for a league administrator a page of up to ${UMPIRE_LEADERBOARD_MAX_PAGE} of everyone, most first or fewest first`,
      security: [{ bearer: [] }],
      parameters: [
        ...parameters,
        {
          name: 'order',
          in: 'query',
          schema: { type: 'string', enum: ['asc', 'desc'] },
          description:
            'desc is most games first and asc is fewest first; equal counts sort by name either way. Asks for a page, which needs a league administrator; desc once limit or offset asks for one'
        },
        {
          name: 'limit',
          in: 'query',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: UMPIRE_LEADERBOARD_MAX_PAGE
          },
          description: `How many people each ranking returns. Asks for a page, which needs a league administrator; ${UMPIRE_LEADERBOARD_MAX_PAGE} once order or offset asks for one`
        },
        {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer', minimum: 0 },
          description:
            'How many people each ranking skips. Asks for a page, which needs a league administrator; 0 once order or limit asks for one'
        }
      ],
      responses: {
        ...responses,
        200: {
          description:
            'Completed and scheduled people rankings and team credits. Without order, limit or offset, the top ten with at least one game. With any of them, every current league umpire, including those with no games, and anyone else with a game still counted, such as a removed umpire, and page: {order, limit, offset, total}; only the real top ten have a symbol. Each of them needs a league administrator. Pages rank live data, so a signup between two reads can move someone across a page boundary.'
        }
      }
    }
  }
  paths['/leagues/{leagueId}/me/umpire-availability'] = {
    get: {
      summary: 'Read your saved umpire availability filter for a league',
      description:
        'For whoever may open the league\u2019s umpire schedule: a league ' +
        'administrator or a holder of its umpire role. Anybody else, and a ' +
        'league that does not manage umpires, gets 404.',
      security: [{ bearer: [] }],
      parameters,
      responses: {
        ...responses,
        200: {
          description: 'The saved filter, null when none is saved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['availability'],
                properties: { availability: umpireAvailabilitySchema }
              }
            }
          }
        }
      }
    },
    put: {
      summary: 'Save your umpire availability filter for a league',
      description:
        'Replaces the saved filter. Null, or a filter with no levels, days ' +
        'or range, clears it. `timezone` is required; `from` and `to` come ' +
        'together, with `to` after `from`. Otherwise 400. A level that is ' +
        'not the league\u2019s (deleted, or another league\u2019s) is ' +
        'dropped, as a read drops it. Who may save is who may read.',
      security: [{ bearer: [] }],
      parameters,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['availability'],
              properties: { availability: umpireAvailabilitySchema }
            }
          }
        }
      },
      responses: {
        ...responses,
        200: {
          description: 'The filter as saved, null when cleared',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['availability'],
                properties: { availability: umpireAvailabilitySchema }
              }
            }
          }
        }
      }
    }
  }
  paths['/leagues/{leagueId}/umpires/{userId}/commitments'] = {
    get: {
      summary:
        'An umpire\u2019s games in a time window, as a league administrator',
      description:
        'The games the umpire is assigned to and the games they play in ' +
        '(through any merged account) that overlap the window: they start ' +
        'by `to` and end at or after `from` (a game with no end lasting the ' +
        'default event length), so a game already under way at `from` ' +
        'counts. Limited to leagues the caller administers, sorted by ' +
        'start. The window is at most 31 days. A person who does not hold ' +
        'this league\u2019s umpire role is 404.',
      security: [{ bearer: [] }],
      parameters: [
        ...parameters,
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        },
        {
          name: 'from',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'date-time' },
          description:
            'An ISO 8601 date-time with `Z` or an explicit offset; any ' +
            'other value is 400.'
        },
        {
          name: 'to',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'date-time' },
          description:
            'An ISO 8601 date-time with `Z` or an explicit offset; any ' +
            'other value is 400.'
        }
      ],
      responses: {
        ...responses,
        200: {
          description: 'The commitments',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['commitments'],
                properties: {
                  commitments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: [
                        'gameId',
                        'leagueId',
                        'startAt',
                        'endAt',
                        'home',
                        'away',
                        'role'
                      ],
                      properties: {
                        gameId: { type: 'string' },
                        leagueId: { type: 'string' },
                        startAt: { type: 'string', format: 'date-time' },
                        endAt: {
                          type: 'string',
                          format: 'date-time',
                          description:
                            'The stored end, or three hours after the start.'
                        },
                        home: { type: 'string' },
                        away: { type: 'string' },
                        role: { type: 'string', enum: ['umpire', 'player'] },
                        slot: {
                          type: 'string',
                          description: 'The umpire position, for `umpire`.'
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return paths
}
