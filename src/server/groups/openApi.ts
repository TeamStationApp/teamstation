import { PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { userIdSchema } from '../userIdSchema'
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
/** A parent, competition, personal-role or promotion invitation. */
const relationship = {
  type: 'object',
  required: ['kind', 'sender', 'idempotencyKey'],
  properties: {
    kind: {
      type: 'string',
      enum: ['parent', 'participation', 'promotion', 'person']
    },
    sender: ref,
    idempotencyKey: retryKey,
    confirmBoth: {
      type: 'boolean',
      default: false,
      description:
        'Apply all approvals the current actor actually holds, including promotion to their own verified account. Never substitutes for another person or group consent. An immediately accepted result is a completed action; pending results still require the remaining approvals.'
    },
    actions: { type: 'array', items: action },
    teamId: { type: 'string' },
    seasonId: { type: 'string' },
    recipientUserId: userIdSchema,
    recipientEmail: {
      type: 'string',
      format: 'email',
      description:
        'Verified active account email; provide this or recipientUserId' +
        '. A person kind requires recipientEmail: an address an account has verified adds that account at once (201 with status `accepted`, and the id of the notification telling them; 409 when it holds all of it already), and only an address nobody has verified is invited, applied when it is verified.'
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
        enum: [
          'coach',
          'assistant',
          'scorekeeper',
          'songkeeper',
          'videographer'
        ]
      }
    }
  }
}
/**
 * A guardian invitation from a team, a guardian's invitation with no sender,
 * or a request with no sender, which names its sender as the guardian.
 */
const guardian = {
  type: 'object',
  required: ['kind', 'playerUserId', 'guardian', 'idempotencyKey'],
  properties: {
    kind: { type: 'string', enum: ['guardian'] },
    playerUserId: userIdSchema,
    guardian: {
      oneOf: [
        {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: {
              ...userIdSchema,
              description:
                'The account; for a request, the sender; for a guardian’s invitation, anybody else'
            }
          }
        },
        {
          type: 'object',
          required: ['email'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              description:
                'Mailed an invitation; an address no account has verified yet is bound to the account that verifies it and accepts'
            }
          }
        }
      ]
    },
    sender: {
      type: 'object',
      required: ['kind', 'id'],
      description:
        "The team the invitation comes from, while the player has no guardian. Absent for a request to be the guardian yourself, and for an invitation from one of the player's guardians.",
      properties: {
        kind: { type: 'string', enum: ['team'] },
        id: { type: 'string' }
      }
    },
    idempotencyKey: retryKey
  }
}
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
          'Send a seven-day relationship or guardian invitation, guardian request or team membership request',
        security: [{ bearer: [] }],
        description:
          'Membership requests use kind=membership and teamId, without sender. The server binds them to the signed-in user, deduplicates pending requests, and requires a team administrator to accept before granting member access, never staff roles. Missing, merged and placeholder teams are refused. ' +
          'Sending records consent for that scope. confirmBoth explicitly records both sides when the sender administers both. Competition does not grant team permissions. Promotion preserves identity and history. ' +
          "Once a player has a guardian, only their guardians (and the player) say who else becomes one; a team's staff speak only for a player with no guardian. Only a guardian whose account can sign in counts: one a roster import made with no email address leaves the say with the team's staff. A site administrator may do all of it. " +
          "A team's guardian invitation comes from a team (`sender`) whose administrator, coach or assistant sends it, about one of the team's players who has no guardian yet (403 `<player> has a guardian already. Ask them to invite another guardian.` once they have one, also when the invitee accepts), to an account or an email address, which is mailed; the invitee accepts. " +
          "A guardian's invitation has no `sender` and names somebody else as `guardian`: a guardian of the player invites another, by account or address, mailed the same way; the invitee accepts, while the sender is still a guardian. Anybody else sending one is refused (403). " +
          'A guardian request has no `sender` and names the signed-in user as `guardian`, who asks to be the guardian of a player on a team they can see; one approval suffices, read when it is given: from the player if their account signs in, from any guardian of the player, or, only while the player has no guardian, from an administrator, coach or assistant of a team the player plays on. Nobody approves their own request. ' +
          "A player cannot be their own guardian (400), nobody invites themselves (400), and somebody who already guards the player is not asked again (409). The same guardian request still waiting (the same sender for the same player, the same guardian inviting the same account or address, or the same team inviting the same account or address for the same player) is answered with 200 and that request; nothing new is sent, and it counts once. The retry key of a guardian request, sent again, gets its first answer (201 or 200, the same body) and sends nothing again, unless the mail of the invitation failed, which it then sends; it is not authorized again, so it answers the same after the sender lost the team or the player left it. A user may have 5 guardian requests and guardian's invitations waiting, and after three of their requests are declined cannot ask again for 7 days (429 `rateLimited`); a team's invitations count toward neither, and a declined invitation never counts. Guardian requests are never resent.",
        requestBody: body({
          oneOf: [
            relationship,
            guardian,
            {
              type: 'object',
              required: ['kind', 'teamId', 'idempotencyKey'],
              properties: {
                kind: { const: 'membership' },
                teamId: { type: 'string' },
                idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 }
              }
            }
          ]
        }),
        responses: {
          ...responses,
          200: {
            description: 'The same guardian request, already waiting'
          },
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
      },
      put: {
        summary: 'Flag a team in a season as an exhibition team, or not',
        security: [{ bearer: [] }],
        description:
          'For a season admin. The team must be an active or parent-managed team of the season. A flagged team is listed under Exhibition Teams, and the Auto-Scheduler gives it exhibition games only.',
        parameters: [parameter('seasonId'), parameter('teamId')],
        requestBody: body({
          type: 'object',
          required: ['exhibition'],
          properties: { exhibition: { type: 'boolean' } }
        }),
        responses: {
          ...responses,
          200: { description: '{ seasonId, teamId, exhibition }' }
        }
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
            picture: { type: 'object' },
            playerNamePrivacy: {
              type: 'string',
              nullable: true,
              enum: [...PLAYER_NAME_PRIVACY, null],
              description:
                "How the public reads this level's player names. Null is Default, which inherits from the seasons and leagues that manage it. Group detail answers the stored value, the resolved format and the levels it was inherited from."
            }
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
                properties: { group: ref, userId: userIdSchema }
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
          'hasPending counts the rows with `canAct` across every page: requests this person can answer, and `recordingUpload` reminders not yet dismissed. The default list is those rows, reminders first; a reminder is `pending` with `canAct` and carries `gameId` and `liveStreamId`. history holds every other status: decided requests, and every piece of information, grants (somebody added you to a team, season or league) and scheduling notices included, which are recorded `accepted` and so are history from the start. A grant carries `leave`, the level it gave, while you are still in it. Viewing an item does not resolve it. Eligibility is recomputed from current roles.',
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
    },
    '/me/notifications/{id}/dismissed': {
      put: {
        summary: 'Dismiss a reminder: it leaves Pending and stays in History',
        description:
          'Records viewing and dismissal for the caller, making the receipt when the notification was never opened. Answers 204. Another person\u2019s notification is 404.',
        security: [{ bearer: [] }],
        parameters: [parameter('id')],
        responses: {
          204: { description: 'Dismissed' },
          401: errorResponse,
          404: errorResponse
        }
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
          'Only group identity, locality, true parents, competition membership, shortened staff names, published schedule and aggregate results. No roster, statistics, private user IDs, contacts, full staff surname, events or media. `nonMemberView` is true on a team for anybody signed in who is not a member of it, following it or not, whose private team reads are the non-member view; false for members, for nobody signed in, and on every season and league. `canManagePeople` is true for its administrators, coaches and assistants, who open anybody on its people list and give or take away every role there but Admin; `canSeePeople` for its members and role holders, who read that list; `canManageRoster`, on a team only, for its administrators, coaches, assistants and scorekeepers, who add and create its players.',
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
                    'Prior request atomically cancelled. Current actor approvals apply immediately; an accepted response includes source {kind,id} for returning to the connection. Otherwise a fresh seven-day request remains pending.'
                }
              }
            : {})
        }
      }
    }
  return paths
}
