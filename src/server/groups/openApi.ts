const ref = {
  type: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['league', 'season', 'team'] },
    id: { type: 'string' }
  }
}
const locality = {
  type: 'object',
  required: ['city', 'region', 'country'],
  properties: {
    city: { type: 'string' },
    region: { type: 'string' },
    country: { type: 'string' },
    placeId: { type: ['string', 'null'] },
    timezone: { type: ['string', 'null'] }
  }
}
const action = {
  type: 'object',
  required: ['operation', 'child', 'parent'],
  properties: {
    operation: { type: 'string', enum: ['attach', 'detach'] },
    child: ref,
    parent: ref
  }
}
const retryKey = { type: 'string', minLength: 8, maxLength: 120 }
const body = (schema: unknown): unknown => ({
  required: true,
  content: { 'application/json': { schema } }
})
const parameter = (name: string): unknown => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' }
})

/** Public summaries and private approvals intentionally use separate contracts. */
export function creationPaths(errorResponse: unknown): Record<string, unknown> {
  const responses = {
    200: { description: 'Current group or invitation state' },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    409: errorResponse,
    503: errorResponse
  }
  const paths: Record<string, unknown> = {
    '/me/groups': {
      get: {
        summary:
          'Your explicitly accessible groups, ordered by season date range',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'role',
            in: 'query',
            description:
              'admin: only the groups you administer, directly or through a parent. Omitted: every group you can see.',
            schema: { type: 'string', enum: ['admin'] }
          }
        ],
        responses
      }
    },
    '/me/follows': {
      get: {
        summary:
          'The leagues, seasons and teams you follow as a fan, oldest first; following grants no access',
        security: [{ bearer: [] }],
        responses
      }
    },
    '/me/follows/{kind}/{id}': {
      put: {
        summary: 'Follow a league, season or team; repeating it is harmless',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'kind',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['league', 'season', 'team'] }
          },
          parameter('id')
        ],
        responses
      },
      delete: {
        summary: 'Stop following a league, season or team',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'kind',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['league', 'season', 'team'] }
          },
          parameter('id')
        ],
        responses
      }
    },
    '/leagues': {
      get: {
        summary: 'Discover league summaries or list administered leagues',
        parameters: [
          {
            name: 'view',
            in: 'query',
            schema: { type: 'string', enum: ['public'] }
          },
          {
            name: 'query',
            in: 'query',
            schema: { type: 'string', maxLength: 120 }
          }
        ],
        responses
      },
      post: {
        summary:
          'Create a league with confirmed locality and creator administration',
        security: [{ bearer: [] }],
        requestBody: body({
          type: 'object',
          required: ['name', 'locality', 'idempotencyKey'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            locality,
            idempotencyKey: retryKey,
            picture: { type: 'object' }
          }
        }),
        responses: {
          ...responses,
          201: { description: 'Idempotently created league' }
        }
      }
    },
    '/parent-previews': {
      post: {
        summary: 'Review all management parent changes before consent',
        security: [{ bearer: [] }],
        requestBody: body({
          type: 'object',
          required: ['actions'],
          properties: {
            actions: { type: 'array', minItems: 1, maxItems: 50, items: action }
          }
        }),
        responses
      }
    },
    '/parent-links': {
      put: {
        summary:
          'Apply a current preview; either endpoint admin may unlink, attachment needs both sides',
        security: [{ bearer: [] }],
        description:
          'Parent changes affect inherited roles only. Competition membership, schedules and results are preserved.',
        requestBody: body({
          type: 'object',
          required: ['actions', 'expected'],
          properties: {
            actions: { type: 'array', items: action },
            expected: {
              type: 'object',
              additionalProperties: { type: 'string' }
            }
          }
        }),
        responses
      }
    },
    '/relationship-requests': {
      post: {
        summary:
          'Send a seven-day parent, competition, personal-role or verified promotion request',
        security: [{ bearer: [] }],
        description:
          'Sending records consent for that scope. confirmBoth explicitly records both sides when the sender administers both. Competition does not grant team permissions. Promotion preserves identity and history.',
        requestBody: body({
          type: 'object',
          required: ['kind', 'sender', 'idempotencyKey'],
          properties: {
            kind: {
              type: 'string',
              enum: ['parent', 'participation', 'promotion', 'person']
            },
            sender: ref,
            idempotencyKey: retryKey,
            confirmBoth: { type: 'boolean' },
            actions: { type: 'array', items: action },
            teamId: { type: 'string' },
            seasonId: { type: 'string' },
            recipientUserId: { type: 'integer' },
            recipientEmail: {
              type: 'string',
              format: 'email',
              description:
                'Verified active account email; provide this or recipientUserId' +
                '. Personal role invitations require recipientEmail; unknown addresses may verify before acceptance.'
            },
            admin: {
              type: 'boolean',
              default: false,
              description: 'Requested personal group administrator role'
            },
            flags: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['coach', 'scorekeeper', 'songkeeper', 'videographer']
              }
            }
          }
        }),
        responses: {
          ...responses,
          201: { description: 'One invitation and its shared approval sides' }
        }
      }
    },
    '/seasons/{seasonId}/memberships/{teamId}': {
      delete: {
        summary:
          'Either endpoint admin ends competition membership, preserving all games and parent permissions',
        security: [{ bearer: [] }],
        parameters: [parameter('seasonId'), parameter('teamId')],
        responses
      }
    },
    '/groups/{kind}/{id}': {
      put: {
        summary:
          'Edit an administered group, its own locality, picture or reference dates',
        security: [{ bearer: [] }],
        parameters: [parameter('kind'), parameter('id')],
        description:
          'Changing season dates or timezone never moves a game; affected pending competition invitations are superseded.',
        requestBody: body({
          type: 'object',
          properties: {
            name: { type: 'string' },
            locality,
            startsOn: { type: 'string', format: 'date' },
            endsOn: { type: 'string', format: 'date' },
            timezone: { type: 'string' },
            picture: { type: 'object' }
          }
        }),
        responses
      }
    },
    '/node/ownership-preflight': {
      get: {
        summary:
          'Node admin privately reviews ownership, custody and direct-admin cutover conflicts',
        security: [{ bearer: [] }],
        responses
      },
      post: {
        summary:
          'Node admin explicitly resolves parent choices and atomically enables management',
        security: [{ bearer: [] }],
        requestBody: body({
          type: 'object',
          properties: {
            administrators: {
              type: 'array',
              items: {
                type: 'object',
                required: ['group', 'userId'],
                properties: { group: ref, userId: { type: 'integer' } }
              }
            },
            custodians: {
              type: 'array',
              items: {
                type: 'object',
                required: ['teamId', 'custodian'],
                properties: { teamId: { type: 'string' }, custodian: ref }
              }
            },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                required: ['teamId', 'parentSeasonIds'],
                properties: {
                  teamId: { type: 'string' },
                  parentSeasonIds: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        }),
        responses
      }
    },
    '/me/notifications': {
      get: {
        summary:
          'Current actionable approvals, oldest first; history=1 selects resolved information',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'sent',
            in: 'query',
            schema: { type: 'string', enum: ['1'] },
            description:
              'Pending outgoing invitations; cannot be combined with history'
          },
          {
            name: 'history',
            in: 'query',
            schema: { type: 'string', enum: ['1'] }
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100 }
          }
        ],
        description:
          'hasPending counts actionable requests across every page. Viewing an item does not resolve it. Eligibility is recomputed from current roles.',
        responses
      }
    },
    '/me/notifications/summary': {
      get: {
        summary: 'Whether any current approval needs action',
        security: [{ bearer: [] }],
        responses
      }
    },
    '/me/notifications/{id}': {
      get: {
        summary: 'Read an invitation or recorded organization update',
        security: [{ bearer: [] }],
        parameters: [parameter('id')],
        responses
      }
    },
    '/me/notifications/{id}/viewed': {
      put: {
        summary:
          'Record personal viewing without changing shared approval state',
        security: [{ bearer: [] }],
        parameters: [parameter('id')],
        responses
      }
    }
  }
  for (const collection of ['leagues', 'seasons', 'teams'])
    paths[`/${collection}/{id}`] = {
      get: {
        summary:
          'Public minimal group profile with optional current management capability',
        parameters: [parameter('id')],
        description:
          'Only group identity, locality, true parents, competition membership, shortened staff names, published schedule and aggregate results. No roster, statistics, private user IDs, contacts, full staff surname, events or media.',
        responses
      }
    }
  paths['/seasons'] = {
    post: {
      summary:
        'Create a reference date range season; optional parent league requires its admin',
      security: [{ bearer: [] }],
      requestBody: body({
        type: 'object',
        required: ['name', 'startsOn', 'endsOn', 'timezone', 'idempotencyKey'],
        properties: {
          name: { type: 'string' },
          startsOn: { type: 'string', format: 'date' },
          endsOn: { type: 'string', format: 'date' },
          timezone: { type: 'string' },
          parent: ref,
          idempotencyKey: retryKey
        }
      }),
      responses: { ...responses, 201: { description: 'Created season' } }
    }
  }
  for (const decision of ['accept', 'decline', 'withdraw', 'resend'])
    paths[`/relationship-requests/{id}/${decision}`] = {
      post: {
        summary: `${decision} a relationship invitation with current authority`,
        security: [{ bearer: [] }],
        parameters: [parameter('id')],
        requestBody: body({
          type: 'object',
          properties: { idempotencyKey: retryKey }
        }),
        responses: {
          ...responses,
          ...(decision === 'resend'
            ? {
                201: {
                  description:
                    'Fresh seven-day request; prior request atomically cancelled'
                }
              }
            : {})
        }
      }
    }
  return paths
}
