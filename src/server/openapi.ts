import {
  API_KEY_AREAS,
  API_KEY_CREATE_WINDOW_MIN,
  API_KEY_CREATES_PER_WINDOW,
  MAX_API_KEY_NAME,
  MAX_API_KEYS
} from '../common/apiKeys'
import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  POSITION_CODES,
  STORED_EVENT_TYPES
} from '../common/gumbo/reference'
import {
  JERSEY_MAX_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_POSITIONS
} from '../common/playerSettings'
import { PITCH_HEIGHTS, PITCH_SIDES } from '../common/scoring/pitchLocation'
import { PITCH_TYPE_CODES } from '../common/scoring/pitchType'
import {
  CLIP_MAX_MS,
  CLIP_MIN_MS,
  WALK_UP_PROVIDERS
} from '../common/walkUpSong'
import { schedulePreviewPaths } from './autoScheduler/schedulePreviewsOpenApi'
import { createEventOperation, eventInfoPaths } from './events/eventInfoOpenApi'
import { MAX_READS } from './graphql/restReader'
import { MAX_DEPTH } from './graphql/schema'
import { creationPaths } from './groups/openApi'
import { MAX_QUERY_LENGTH } from './routes/graphql'
import { gameApprovalPaths } from './schedule/gameApprovalOpenApi'
import { schedulingSetupPaths } from './scheduler/schedulingSetupOpenApi'
import { tessPaths } from './tess/openApi'
import { umpirePaths } from './umpires/openApi'
import { nullableGumboIdSchema, userIdSchema } from './userIdSchema'
import { venuePaths } from './venues/venuesOpenApi'

const PUBLIC_NAME =
  "The public name: first name and last initial, unless the player's league, season or team chose another format."

const recordSchema = {
  type: 'object',
  required: ['w', 'l', 't'],
  properties: {
    w: { type: 'integer' },
    l: { type: 'integer' },
    t: { type: 'integer' }
  }
}
const battingCounts = [
  'g',
  'pa',
  'ab',
  'h',
  'singles',
  'doubles',
  'triples',
  'hr',
  'bb',
  'k',
  'r',
  'hbp',
  'rbi',
  'sb',
  'cs',
  'sf',
  'sh'
]
const pitchingCounts = [
  'g',
  'outs',
  'bf',
  'h',
  'hr',
  'hbp',
  'r',
  'er',
  'bb',
  'k'
]
const statIdentity = {
  userId: userIdSchema,
  shortName: { type: 'string' },
  teamId: { type: ['string', 'null'] }
}
const battingSchema = {
  type: 'object',
  required: ['userId', 'teamId', ...battingCounts, 'rates'],
  properties: {
    ...statIdentity,
    ...Object.fromEntries(
      battingCounts.map(name => [name, { type: 'number' }])
    ),
    rates: {
      type: 'object',
      properties: Object.fromEntries(
        ['avg', 'obp', 'slg', 'ops', 'sbPct'].map(name => [
          name,
          { type: 'number' }
        ])
      )
    }
  }
}
const pitchingSchema = {
  type: 'object',
  required: ['userId', 'teamId', ...pitchingCounts, 'ip', 'rates'],
  properties: {
    ...statIdentity,
    ...Object.fromEntries(
      pitchingCounts.map(name => [name, { type: 'number' }])
    ),
    ip: { type: 'string' },
    rates: {
      type: 'object',
      properties: Object.fromEntries(
        ['era', 'whip', 'baa', 'sbPct'].map(name => [name, { type: 'number' }])
      )
    }
  }
}
const standingsSchema = {
  type: 'object',
  required: [
    'teamId',
    'teamName',
    'teamKind',
    'logoUrl',
    'w',
    'l',
    't',
    'played',
    'winningPct',
    'gamesBehind',
    'runsFor',
    'runsAgainst',
    'runDifferential',
    'streak',
    'home',
    'away'
  ],
  properties: {
    teamId: { type: 'string' },
    teamName: { type: 'string' },
    teamKind: { type: 'string', enum: ['full', 'external'] },
    logoUrl: { type: ['string', 'null'] },
    ...Object.fromEntries(
      [
        'w',
        'l',
        't',
        'played',
        'runsFor',
        'runsAgainst',
        'runDifferential'
      ].map(name => [name, { type: 'integer' }])
    ),
    winningPct: { type: ['number', 'null'] },
    gamesBehind: { type: ['number', 'null'] },
    streak: { type: ['string', 'null'] },
    home: recordSchema,
    away: recordSchema
  }
}

const argonParameters = {
  type: 'object',
  required: [
    'algorithm',
    'version',
    'memoryKiB',
    'iterations',
    'parallelism',
    'hashLength',
    'salt'
  ],
  properties: {
    algorithm: { type: 'string', enum: ['argon2id'] },
    version: { type: 'integer', enum: [19] },
    memoryKiB: {
      type: 'integer',
      minimum: 19456,
      maximum: 65536,
      description: 'Multiple of four times parallelism'
    },
    iterations: { type: 'integer', minimum: 2, maximum: 1024 },
    parallelism: { type: 'integer', minimum: 1, maximum: 4 },
    hashLength: { type: 'integer', enum: [32] },
    salt: { type: 'string', pattern: '^[0-9a-f]{32}$' }
  }
}
const clientHashSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
  writeOnly: true
}

const accountResponse = {
  description:
    'The account identity, password status and accepted email addresses',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: [
          'user',
          'hasPassword',
          'emails',
          'passwordNeedsUpgrade',
          'passwordParameters',
          'newPasswordSalt'
        ],
        properties: {
          user: { $ref: '#/components/schemas/User' },
          hasPassword: { type: 'boolean' },
          passwordNeedsUpgrade: { type: 'boolean' },
          newPasswordSalt: { type: 'string', pattern: '^[0-9a-f]{32}$' },
          passwordParameters: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  client: argonParameters,
                  server: {
                    ...argonParameters,
                    properties: {
                      ...argonParameters.properties,
                      iterations: { type: 'integer', minimum: 8, maximum: 4096 }
                    }
                  }
                }
              }
            ]
          },
          emails: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'email', 'isPrimary'],
              properties: {
                id: { type: 'string' },
                email: { type: 'string', format: 'email' },
                isPrimary: { type: 'boolean' },
                isVerified: {
                  type: 'boolean',
                  description: 'Whether this account has verified the address.'
                }
              }
            }
          }
        }
      }
    }
  }
}
const apiKeyPermissionSchema = {
  type: 'string',
  enum: API_KEY_AREAS.flatMap(area => [`${area}:read`, `${area}:write`])
}
const apiKeySchema = {
  type: 'object',
  required: ['id', 'name', 'secret', 'createdAt', 'permissions'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    secret: {
      type: ['string', 'null'],
      description:
        'The bearer token. Null only when the server secret changed since the key was made.'
    },
    createdAt: { type: 'string', format: 'date-time' },
    permissions: { type: 'array', items: apiKeyPermissionSchema }
  }
}
const apiKeyPaths = {
  '/me/api-keys': {
    get: {
      security: [{ bearer: [] }],
      summary: 'List your API keys (signed-in sessions only)',
      description:
        'Active keys, oldest first, each with its secret. A machine token, Tess and an API key are refused.',
      responses: {
        200: {
          description: 'Your keys',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { keys: { type: 'array', items: apiKeySchema } }
              }
            }
          }
        },
        403: { description: 'Not a signed-in session' }
      }
    },
    post: {
      security: [{ bearer: [] }],
      summary: 'Create an API key (signed-in sessions only)',
      description: `A key calls this API as you, within its permissions: \`<area>:read\` allows GET and HEAD on that area’s routes, \`<area>:write\` allows POST, PUT, PATCH and DELETE, and write is stored with read. Any route outside the areas answers 403 to a key. A key does not expire. An account holds at most ${MAX_API_KEYS} keys and may create ${API_KEY_CREATES_PER_WINDOW} per ${API_KEY_CREATE_WINDOW_MIN} minutes.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'permissions'],
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_API_KEY_NAME
                },
                permissions: {
                  type: 'array',
                  minItems: 1,
                  items: apiKeyPermissionSchema
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'The new key, with its secret',
          content: { 'application/json': { schema: apiKeySchema } }
        },
        400: { description: 'A blank name or no permission' },
        403: { description: 'Not a signed-in session' },
        409: { description: `The account already holds ${MAX_API_KEYS} keys` },
        429: { description: 'Too many keys created recently' }
      }
    }
  },
  '/me/api-keys/{id}': {
    delete: {
      security: [{ bearer: [] }],
      summary: 'Revoke one of your API keys (signed-in sessions only)',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
      ],
      responses: {
        204: { description: 'Revoked; the key is refused from now on' },
        403: { description: 'Not a signed-in session' },
        404: { description: 'No such active key on your account' }
      }
    }
  }
}
const graphqlPaths = {
  '/graphql': {
    post: {
      security: [{ bearer: [] }],
      summary:
        'Read teams, games, players, seasons and stat lines with one GraphQL query',
      description: `Read-only: the schema has a query type and no mutation or subscription. Each field is read from the REST route that serves it, as you, so a field holds exactly what that route gives you — a short name where you may not see the full one, a game’s non-member view, a stat line only for a game you may open — and a field that route refuses is an error, with its status in \`extensions.status\`, and null. Introspection is open. An API key needs any read permission to send a query, and each field’s own family to read it. At most ${MAX_QUERY_LENGTH} characters, ${MAX_DEPTH} levels deep and ${MAX_READS} route reads a query.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string', maxLength: MAX_QUERY_LENGTH },
                variables: { type: 'object', additionalProperties: true },
                operationName: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description:
            'The data, with an error for each field that could not be read',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: ['object', 'null'],
                    additionalProperties: true
                  },
                  errors: {
                    type: 'array',
                    items: { type: 'object', additionalProperties: true }
                  }
                }
              }
            }
          }
        },
        400: {
          description:
            'The query does not parse or validate, is a mutation, or is too long or too deep'
        },
        401: { description: 'Not signed in' }
      }
    }
  }
}
const accountPaths = {
  '/me/account': {
    get: {
      security: [{ bearer: [] }],
      summary: 'Read your account settings (signed-in sessions only)',
      responses: { 200: accountResponse }
    },
    delete: {
      security: [{ bearer: [] }],
      summary: 'Delete your account (signed-in sessions only)',
      description:
        'Irrecoverable. For the account and every account merged into it: renames it "Deleted user", which every play, highlight, lineup, scoreboard and notification naming it reads, none keeping a copy; removes its email addresses, password, uploaded pictures, bats and throws, walk-up songs, family links, roles, follows, tags and notifications; spends pending sign-in codes; marks it deleted, which keeps it disabled for good; and revokes its sessions, tokens, grants and stream keys. Plays, stats, roster places, RSVPs and import ids stay, under that name. Refused for the last node administrator and for the last direct administrator of a team, season or league, naming every such group.',
      responses: {
        204: { description: 'Deleted' },
        409: {
          description:
            'The last node administrator, or the last direct administrator of a group, cannot be deleted'
        }
      }
    }
  },
  '/me/account/name': {
    put: {
      security: [{ bearer: [] }],
      summary: 'Save your name',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['displayName'],
              properties: {
                displayName: { type: 'string', minLength: 1, maxLength: 120 }
              }
            }
          }
        }
      },
      responses: { 200: accountResponse }
    }
  },
  '/me/account/photo': {
    delete: {
      security: [{ bearer: [] }],
      summary: 'Use initials for your account picture',
      description:
        'Clear your own picture reference without deleting shared sports catalog objects.',
      responses: { 200: accountResponse }
    },
    put: {
      security: [{ bearer: [] }],
      summary:
        'Store your profile picture in the configured DigitalOcean Space',
      description:
        'JPEG, PNG or WebP; at most 10 MiB decoded. Both normalized PNG renditions are uploaded before the account changes. Source is always upload.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['image'],
              properties: {
                image: {
                  type: 'object',
                  required: ['contentType', 'base64'],
                  properties: {
                    contentType: {
                      type: 'string',
                      enum: ['image/jpeg', 'image/png', 'image/webp']
                    },
                    base64: { type: 'string', contentEncoding: 'base64' }
                  }
                }
              }
            }
          }
        }
      },
      responses: { 200: accountResponse }
    }
  },
  '/me/account/password': {
    put: {
      security: [{ bearer: [] }],
      summary: 'Set or change your password',
      description:
        'Submit a 32-byte client Argon2id hash and client-selected parameters. A currentClientHash using saved parameters is required for a password change, or a fresh reset email code. Legacy credentials always require the reset code. Raw password/currentPassword fields are rejected. Clients require at least 8 Unicode characters with uppercase, lowercase and a number; at 17 or more characters composition is waived. Maximum 1024 UTF-8 bytes. Clients calibrate asynchronously from at least 32 MiB, 6 iterations and 4 lanes toward 3000 ms. Server uses independent salt and four times client iterations; both parameter sets and only the final server hash are stored.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['clientHash', 'clientParameters'],
              properties: {
                clientHash: clientHashSchema,
                clientParameters: {
                  ...argonParameters,
                  properties: {
                    ...argonParameters.properties,
                    memoryKiB: {
                      ...argonParameters.properties.memoryKiB,
                      minimum: 32768
                    },
                    iterations: { type: 'integer', minimum: 6, maximum: 1024 },
                    parallelism: { type: 'integer', enum: [4] }
                  }
                },
                currentClientHash: clientHashSchema,
                reset: {
                  type: 'object',
                  required: ['requestId', 'code'],
                  properties: {
                    requestId: { type: 'string' },
                    code: { type: 'string', writeOnly: true }
                  }
                }
              }
            }
          }
        }
      },
      responses: { 200: accountResponse }
    }
  },
  '/me/account/password/reset': {
    post: {
      security: [{ bearer: [] }],
      summary: 'Send an email code to reset your password',
      description:
        'Uses an accepted account email. Expires after 10 minutes or five wrong guesses; a new request supersedes the old one. Bound to this account and current credential. Submit the code with PUT /me/account/password.',
      responses: {
        202: {
          description: 'Code sent',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'email'],
                properties: {
                  requestId: { type: 'string' },
                  email: { type: 'string', format: 'email' }
                }
              }
            }
          }
        }
      }
    }
  },
  '/me/account/emails/request': {
    post: {
      security: [{ bearer: [] }],
      summary: 'Send a confirmation code for an added or replacement address',
      description:
        'The address is not accepted until confirmed. A replacement keeps the existing address active. Codes expire after 10 minutes and 5 wrong guesses; resending invalidates earlier codes. Existing addresses on another account are refused.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', format: 'email' },
                replaceEmailId: { type: 'string' }
              }
            }
          }
        }
      },
      responses: {
        202: {
          description: 'Code sent',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId'],
                properties: { requestId: { type: 'string' } }
              }
            }
          }
        }
      }
    }
  },
  '/me/account/emails/confirm': {
    post: {
      security: [{ bearer: [] }],
      summary: 'Accept the address after confirming its code',
      description:
        'Requests belong to the signed-in account and may only be consumed once. Replacements retain primary status.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['requestId', 'code'],
              properties: {
                requestId: { type: 'string' },
                code: { type: 'string', writeOnly: true }
              }
            }
          }
        }
      },
      responses: { 200: accountResponse }
    }
  },
  '/me/account/emails/primary': {
    put: {
      security: [{ bearer: [] }],
      summary: 'Choose your primary email from your accepted addresses',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['emailId'],
              properties: { emailId: { type: 'string' } }
            }
          }
        }
      },
      responses: { 200: accountResponse }
    }
  }
}

/**
 * The API's own description, served at `/api/v1/openapi.json`.
 *
 * It is written by hand rather than generated, because the cleaners describe
 * what the code accepts and this describes what the API promises; keeping them
 * apart means a careless change to a cleaner cannot silently rewrite the
 * contract. The route tests check the two agree.
 */
export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string }>
  components: Record<string, unknown>
  paths: Record<string, unknown>
}

const teamIdParam = {
  name: 'teamId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

/** What a schedule list takes to answer a page at a time. */
const schedulePageParams = [
  {
    name: 'paged',
    in: 'query',
    description:
      'Answer `{items, nextCursor, prevCursor, anchorId, counts}`. Without it the list is the bare array.',
    schema: { type: 'string', enum: ['1', 'true'] }
  },
  {
    name: 'cursor',
    in: 'query',
    description:
      "A `nextCursor` or `prevCursor`, with the filters of the query that gave it. It carries its list's order, so `order` may be left out, and an `order` that disagrees is a 400. Needs `paged`. A malformed one is a 400.",
    schema: { type: 'string' }
  },
  {
    name: 'around',
    in: 'query',
    description:
      "`next` opens a first page on the list's next game, in `asc` order, with rows before it. Needs `paged`, and does not take `cursor` or `order=desc`.",
    schema: { type: 'string', enum: ['next'] }
  },
  {
    name: 'hasVideo',
    in: 'query',
    description: 'Keep only games with a video that is not hidden.',
    schema: { type: 'string', enum: ['1', 'true'] }
  }
]

const gameIdParam = {
  name: 'gameId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

/**
 * A queued write's key: the same request sent again with it is answered as
 * the first was and writes nothing; the same key on another request is 409.
 */
const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Optional. A key the sender makes for this one request, 1 to 200 ' +
    'visible ASCII characters. Sent again with the same method, path and ' +
    'body, the stored answer is returned and nothing is written again; ' +
    'with any other request, 409. Without it the write behaves as always.',
  schema: { type: 'string', minLength: 1, maxLength: 200 }
}

const streamIdParam = {
  name: 'streamId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const uploadIdParam = {
  name: 'uploadId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const videoIdParam = {
  name: 'videoId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const userIdParam = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: userIdSchema
}

const conversationIdParam = {
  name: 'conversationId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const pathParam = (name: string): Record<string, unknown> => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' }
})

/** A JSON body whose fields are all base64url strings unless typed. */
const keyBody = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties)
): Record<string, unknown> => ({
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required,
        properties
      }
    }
  }
})

const b64 = { type: 'string', description: 'base64url' }

const identityBody = keyBody({
  identityId: {
    type: 'string',
    description: '`cid_` and 16 base64url characters, made by the device'
  },
  identityPublicKey: b64,
  pukPublicKey: b64,
  pukSignature: b64,
  box: b64
})

const userIdsBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['userIds'],
        properties: {
          userIds: { type: 'array', items: userIdSchema }
        }
      }
    }
  }
}

const errorResponse = {
  description: 'The one error shape used by every failure',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiError' }
    }
  }
}

/** The three path pieces the manage page's endpoints share. */
const scopeTypeParam = {
  name: 'scopeType',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['league', 'season', 'team'] }
}
const scopeIdParam = {
  name: 'scopeId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}
/** A role one person is given or loses at a level, or its membership. */
const roleParam = {
  name: 'role',
  in: 'path',
  required: true,
  schema: {
    type: 'string',
    enum: [
      'admin',
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer',
      'member'
    ]
  }
}
const roleOnlyParam = {
  name: 'role',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/Role' }
}
const kindParam = {
  name: 'kind',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['league', 'season', 'team'] }
}
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}
const heldAtResponse = {
  description: 'What they hold at the level itself now',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/HeldAt' }
    }
  }
}
/** Feet to the fence a level sets, or null to leave it to the one above. */
const fenceDistanceFt = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: 600
}
const fenceDistanceBody = {
  type: 'object',
  required: ['fenceDistanceFt'],
  properties: { fenceDistanceFt }
}

/** Anything with an id and a name, which is how the tree is drawn. */
const namedThing = {
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } }
}

/** An id another system has for a person, by the rules `POST /teams` uses. */
const memberExternalId = {
  type: 'object',
  required: ['system', 'kind', 'id'],
  properties: {
    system: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]{0,31}$' },
    kind: { type: 'string', minLength: 1 },
    id: { type: 'string', minLength: 1 }
  }
}

/** A person's two names, trimmed; either may be empty. */
const personNames = {
  firstName: { type: 'string', maxLength: 100 },
  lastName: { type: 'string', maxLength: 100 }
}

/** Why one row of a roster call was refused while the others applied. */
const memberRowError = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', enum: ['conflict'] },
    message: { type: 'string' }
  }
}

/** The body both picture routes take. */
const pictureBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['image', 'source'],
        properties: {
          image: {
            type: 'object',
            required: ['contentType', 'base64'],
            properties: {
              contentType: {
                type: 'string',
                enum: ['image/jpeg', 'image/png', 'image/webp']
              },
              base64: {
                type: 'string',
                pattern: '^[A-Za-z0-9+/]+={0,2}$',
                description:
                  'The bytes, as strict base64 whose length divides by 4; ' +
                  'at most 10 MiB decoded'
              }
            }
          },
          source: { type: 'string', enum: ['import', 'upload'] }
        }
      }
    }
  }
}

/** What both picture routes answer. */
const pictureAnswer = {
  description:
    'Stored, with the signed URL of the 192 px rendition; or not stored, ' +
    'because it was the picture already held, or because an import met an ' +
    'uploaded picture (`kept: upload`)',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['stored'],
        properties: {
          stored: { type: 'boolean' },
          url: { type: 'string' },
          kept: { type: 'string', enum: ['upload'] }
        }
      }
    }
  }
}

/** How both picture routes are described, after their first line. */
const pictureRules =
  '**Who may call:** an administrator of the team (set on the team, its ' +
  'season or its league, or its owner or manager) or a site ' +
  'administrator. Anyone else gets 403; a team the caller cannot see gets ' +
  '404.\n\n' +
  '**The body:** `image` `{contentType, base64}` and `source` (`import` or ' +
  '`upload`). A content type other than `image/jpeg`, `image/png` or ' +
  '`image/webp` is 415. `base64` that is empty, outside the alphabet or of ' +
  'a length that does not divide by 4 is 400. More than 10 MiB decoded is ' +
  '413. Bytes that do not begin with the declared type\u2019s signature ' +
  '(JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF`, a length, ' +
  '`WEBP`) are 415, as are bytes that are not a picture TeamStation can ' +
  'read.\n\n' +
  '**What is stored:** the picture is normalised to square PNGs of 96 and ' +
  '192 px, named by the hash of their bytes. The same picture again uploads ' +
  'nothing and answers `stored: false`. An `import` never replaces a picture ' +
  'whose source is `upload`, and answers `stored: false, kept: upload`. ' +
  'No picture store configured, or one that does not answer, is 503.'

const sorted = (codes: ReadonlySet<string>): string[] => [...codes].sort()

/** A player a play names: his TeamStation user id, or only a name. */
const gumboPerson = {
  type: 'object',
  properties: {
    id: { type: ['integer', 'null'] },
    fullName: { type: 'string' }
  }
}
const gumboBase = { type: ['string', 'null'], enum: [null, '1B', '2B', '3B'] }
const gumboEventType = {
  type: 'string',
  enum: sorted(STORED_EVENT_TYPES),
  description:
    "MLB's event types (`statsapi.mlb.com/api/v1/eventTypes`) and " +
    "TeamStation's extensions: `final_score` and `score_correction` (an " +
    'import), `ts_manual_placement` (a batter the scorer put ' +
    'on base by hand), `ts_batter_out` (a batter out on a play MLB has no ' +
    'code for), `ts_batting_order` (a change of batting order) and ' +
    '`ts_courtesy_runner` (a pinch runner who takes a runner’s base and ' +
    'leaves the batting order as it is). A post ' +
    'may still send `catcher_interference`, `placed_runner` or ' +
    '`manual_placement`; they are stored as `catcher_interf`, ' +
    '`runner_placed` and `ts_manual_placement`. It may also send the ' +
    "names older imports used, each stored as MLB's or " +
    "TeamStation's code: `runner_out` as `other_out`, `batter_out` as " +
    '`field_out`, `catcher_s_interference` as `catcher_interf`, ' +
    '`fc_double_play` as `double_play`, `offensive_interference` as ' +
    '`batter_interference`, `batter_put_on_base` as `ts_manual_placement` ' +
    'and `inning_changed_by_scorekeeper` as `final_score`.'
}
const gumboPosition = {
  type: 'object',
  required: ['code', 'name', 'type', 'abbreviation'],
  properties: {
    code: { type: 'string', enum: sorted(POSITION_CODES) },
    name: { type: 'string' },
    type: { type: 'string' },
    abbreviation: { type: 'string' }
  }
}
const gumboCount = {
  type: 'object',
  properties: {
    balls: { type: 'integer' },
    strikes: { type: 'integer' },
    outs: { type: 'integer' }
  }
}

/**
 * The stored play: a standard MLB Gumbo play, in the shape of the live feed
 * (`statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`, `liveData.plays`).
 */
/**
 * The node settings as `GET /node/settings` answers them and `PUT` takes and
 * answers them: one copy, so the three cannot drift apart (`asNodeSettings`).
 */
const nodeSettingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scoreboard', 'highlights'],
  properties: {
    replay: {
      type: 'object',
      additionalProperties: false,
      description:
        "The 3D replay's pace. A save from an older client omits it and keeps the stored pace; a read always has it.",
      required: ['pitchSec'],
      properties: {
        pitchSec: {
          type: 'integer',
          minimum: 1,
          maximum: 600,
          default: 5,
          description: 'How long a replay holds each pitch, in seconds'
        }
      }
    },
    radar: {
      type: 'object',
      additionalProperties: false,
      description:
        'Radar matching windows; omitted by older clients to use defaults.',
      required: ['pitchWindowSec', 'inPlayWindowSec'],
      properties: {
        pitchWindowSec: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 600,
          default: 3
        },
        inPlayWindowSec: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 600,
          default: 15
        }
      }
    },
    scoreboard: {
      type: 'object',
      additionalProperties: false,
      required: [
        'overlayStartDate',
        'single',
        'landscape',
        'portraitHeight',
        'speedHoldSec'
      ],
      properties: {
        overlayStartDate: {
          type: 'string',
          format: 'date',
          description:
            'The first date, in UTC, whose games show the board: a game starting at or after its 00:00 UTC'
        },
        single: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'height'],
          properties: {
            x: {
              type: 'number',
              minimum: 0,
              exclusiveMaximum: 1
            },
            y: {
              type: 'number',
              minimum: 0,
              exclusiveMaximum: 1
            },
            height: {
              type: 'number',
              exclusiveMinimum: 0,
              maximum: 1
            }
          }
        },
        landscape: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'height'],
          properties: {
            x: {
              type: 'number',
              minimum: 0,
              exclusiveMaximum: 1
            },
            y: {
              type: 'number',
              minimum: 0,
              exclusiveMaximum: 1
            },
            height: {
              type: 'number',
              exclusiveMinimum: 0,
              maximum: 1
            }
          }
        },
        portraitHeight: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 1
        },
        speedHoldSec: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 600
        }
      }
    },
    highlights: {
      type: 'object',
      additionalProperties: false,
      required: ['lagSec', 'leadSec', 'leadSecByEventType', 'mergeWithinSec'],
      properties: {
        lagSec: { type: 'number', minimum: 0, maximum: 600 },
        leadSec: { type: 'number', minimum: 0, maximum: 600 },
        leadSecByEventType: {
          type: 'object',
          // A play type as `asLeadMap` takes one: lower case, digits and
          // underscores, starting with a letter.
          propertyNames: { pattern: '^[a-z][a-z0-9_]*$' },
          additionalProperties: {
            type: 'number',
            minimum: 0,
            maximum: 600
          }
        },
        mergeWithinSec: {
          type: 'number',
          minimum: 0,
          maximum: 600
        },
        // Not required: a body from an app before the setting keeps the
        // node's own.
        tailSec: { type: 'number', minimum: 0, maximum: 600 }
      }
    }
  }
}

const gumboSchemas = {
  GumboPlay: {
    type: 'object',
    description:
      'One play as MLB’s live feed writes it (`liveData.plays.allPlays[]`), ' +
      'with its codes on the MLB lists checked in under ' +
      '`src/common/gumbo/reference/`. `npm run validate-gumbo` checks every ' +
      'stored play against them. TeamStation adds only the `teamStation` ' +
      'record, the `ts_` event types and `about.halfOuts`. A play another ' +
      'service posted carries what that service knew; the stats builder ' +
      'needs the fields the events route lists.',
    required: ['about', 'result'],
    properties: {
      about: {
        type: 'object',
        required: ['atBatIndex'],
        properties: {
          atBatIndex: { type: 'integer' },
          inning: { type: ['integer', 'null'] },
          halfInning: {
            type: ['string', 'null'],
            enum: ['top', 'bottom', null]
          },
          isTopInning: { type: 'boolean' },
          isComplete: { type: 'boolean' },
          isScoringPlay: { type: 'boolean' },
          hasOut: { type: 'boolean' },
          hasReview: { type: 'boolean' },
          startTime: { type: ['string', 'null'], format: 'date-time' },
          endTime: { type: ['string', 'null'], format: 'date-time' },
          halfOuts: {
            type: 'integer',
            description:
              'TeamStation extension, written by the server on the last ' +
              'play of each half: the outs the half ended with. An imported ' +
              "half's can come from an Inning Ended marker and differ from " +
              "the play's `count.outs`."
          }
        }
      },
      result: {
        type: 'object',
        required: ['eventType'],
        properties: {
          type: { type: 'string', enum: ['atBat'] },
          event: {
            type: 'string',
            description:
              "MLB's name for the event type (`Forceout`, `Sac Bunt`); a " +
              '`field_out` is `Groundout`, `Flyout`, `Lineout`, `Pop Out` or a ' +
              'bunt out.'
          },
          eventType: gumboEventType,
          description: { type: 'string' },
          rbi: { type: ['integer', 'null'] },
          awayScore: { type: ['integer', 'null'] },
          homeScore: { type: ['integer', 'null'] },
          isOut: { type: 'boolean' }
        }
      },
      count: gumboCount,
      matchup: {
        type: 'object',
        properties: {
          batter: gumboPerson,
          batSide: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: ['L', 'R', 'S'] },
              description: { type: 'string' }
            }
          },
          pitcher: gumboPerson,
          pitchHand: {
            type: 'object',
            description:
              'Written when the roster knows how the pitcher throws.',
            properties: {
              code: { type: 'string', enum: ['L', 'R'] },
              description: { type: 'string' }
            }
          }
        }
      },
      runners: {
        type: 'array',
        items: { $ref: '#/components/schemas/GumboRunner' }
      },
      playEvents: {
        type: 'array',
        items: {
          oneOf: [
            { $ref: '#/components/schemas/GumboPitchEvent' },
            { $ref: '#/components/schemas/GumboActionEvent' }
          ]
        }
      },
      pitchIndex: { type: 'array', items: { type: 'integer' } },
      actionIndex: { type: 'array', items: { type: 'integer' } },
      runnerIndex: { type: 'array', items: { type: 'integer' } },
      credits: {
        type: 'array',
        description:
          'Who a highlight of this play credits, by `creditUserId`: the ' +
          'batter, the pitcher or the fielders, and every runner who scored ' +
          '(`run`) or stole (`stolen_base`). Not a Gumbo field; the credits ' +
          'are what highlights and a player’s plays are read from.',
        items: { type: 'object' }
      },
      teamStation: { $ref: '#/components/schemas/TeamStationRecord' }
    }
  },
  GumboRunner: {
    type: 'object',
    description:
      'One movement of one runner, in the order they happened. A play ' +
      'TeamStation scored carries every key; one another service posted, ' +
      'those it knew.',
    properties: {
      movement: {
        type: 'object',
        properties: {
          originBase: {
            ...gumboBase,
            description:
              'Where he stood when the plate appearance began; null for the ' +
              'batter.'
          },
          start: { ...gumboBase, description: 'Null for the batter.' },
          end: {
            type: ['string', 'null'],
            enum: [null, '1B', '2B', '3B', 'score'],
            description:
              'Null when he is out. A run a third-out force took back holds ' +
              'his base.'
          },
          outBase: {
            type: ['string', 'null'],
            enum: [null, '1B', '2B', '3B', '4B']
          },
          isOut: { type: 'boolean' },
          outNumber: { type: ['integer', 'null'] }
        }
      },
      details: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          eventType: {
            ...gumboEventType,
            description:
              "The play's event type, or the action's that moved him " +
              '(`wild_pitch`, `stolen_base_2b`, `runner_placed`, …).'
          },
          movementReason: {
            type: ['string', 'null'],
            enum: [null, ...sorted(MOVEMENT_REASONS)],
            description:
              "MLB's runner detail types (`api/v1/runnerDetailTypes`) and " +
              "the feed's `r_adv_play`; null for the batter."
          },
          runner: gumboPerson,
          responsiblePitcher: {
            type: ['object', 'null'],
            description:
              'The pitcher charged with him, `{id}`, on every scoring runner ' +
              "and on a walked batter's own entry.",
            properties: { id: { type: ['integer', 'null'] } }
          },
          isScoringEvent: { type: 'boolean' },
          rbi: { type: 'boolean' },
          earned: { type: 'boolean' },
          teamUnearned: { type: 'boolean' },
          playIndex: {
            type: 'integer',
            description: 'The index of the play event that moved him.'
          }
        }
      },
      credits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['player', 'credit'],
          properties: {
            player: gumboPerson,
            position: {
              ...gumboPosition,
              description: 'Left out for a fielder not on defence.'
            },
            credit: {
              type: 'string',
              description:
                '`f_putout`, `f_assist`, `f_fielded_ball`, ' +
                '`f_fielding_error`, `f_throwing_error`, …'
            }
          }
        }
      }
    }
  },
  GumboPitchEvent: {
    type: 'object',
    required: ['index', 'isPitch', 'type', 'details'],
    properties: {
      index: { type: 'integer' },
      pitchNumber: { type: 'integer' },
      isPitch: { type: 'boolean', enum: [true] },
      type: { type: 'string', enum: ['pitch'] },
      details: {
        type: 'object',
        properties: {
          call: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: sorted(PITCH_CODES) },
              description: { type: 'string' }
            }
          },
          code: {
            type: 'string',
            enum: sorted(PITCH_CODES),
            description:
              "MLB's pitch codes (`api/v1/pitchCodes`). TeamStation writes " +
              '`B`, `C`, `S`, `F`, `T`, `L` and `H` from the call, and for the ' +
              'ball in play `E` when it scored a run, else `X` when it made an ' +
              'out, else `D`. A dropped third strike is an `S`.'
          },
          description: { type: 'string' },
          isInPlay: { type: 'boolean' },
          isStrike: { type: 'boolean' },
          isBall: { type: 'boolean' },
          type: {
            type: 'object',
            description:
              'The kind of pitch the scorer named, as MLB codes it ' +
              '(`api/v1/pitchTypes`). Absent when none was named.',
            properties: {
              code: { type: 'string', enum: PITCH_TYPE_CODES },
              description: { type: 'string' }
            }
          },
          isOut: { type: 'boolean' },
          hasReview: { type: 'boolean' }
        }
      },
      count: { ...gumboCount, description: 'The count after the pitch.' },
      pitchData: {
        type: 'object',
        description:
          'Pitch speed in mph from a matching radar packet, and the scorer’s zone and location. No tracking coordinates.',
        properties: {
          startSpeed: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Miles an hour, to a tenth.'
          },
          zone: {
            type: 'integer',
            description:
              "MLB's zone as the catcher sees it: 1-9 the strike zone from " +
              'top left, 11-14 the corners outside it.'
          },
          location: {
            type: 'object',
            description:
              'Where the scorer said the pitch crossed the plate, from the ' +
              "batter's side. A TeamStation field; Gumbo has none.",
            required: ['height', 'side', 'inZone'],
            properties: {
              height: { type: 'string', enum: [...PITCH_HEIGHTS] },
              side: { type: 'string', enum: [...PITCH_SIDES] },
              inZone: { type: 'boolean' }
            }
          }
        }
      },
      hitData: {
        type: 'object',
        description:
          'On the pitch put in play only, and only what the scorer gave. ' +
          '`launchAngle` is the angle the scorer dragged on the field. ' +
          '`totalDistance` and `coordinates` are where the scorer put the ' +
          "ball, sized by the game's fence distance (`fenceDistanceFt` on " +
          '`GET /games/{gameId}`, 200 feet unless the game, its season or ' +
          'its league says otherwise). Radar launchSpeed is mph, only for fair balls in play; a ' +
          'dictated angle, the untouched default, or one estimated from a ' +
          'trajectory alone stays in the `teamStation` record.',
        properties: {
          launchSpeed: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Radar exit velocity in mph; never on a foul.'
          },
          launchAngle: {
            type: 'number',
            description: 'Degrees, -90 to 90, as the scorer dragged it.'
          },
          totalDistance: {
            type: 'number',
            exclusiveMinimum: 0,
            description:
              'Whole feet from home plate to where the scorer put the ball: ' +
              "a ball on the fence went the game's fence distance. Only when " +
              'the scorer placed the ball.'
          },
          trajectory: { type: 'string', enum: sorted(HIT_TRAJECTORIES) },
          location: {
            type: 'string',
            description: "The fielder's position code, e.g. `8`."
          },
          coordinates: {
            type: 'object',
            description:
              "MLB's 250 by 250 spray chart, home plate at (125, 204), 2.4 " +
              "feet to a unit: the game's fence is its distance over 2.4 " +
              'units from home, the foul poles at 45°.',
            properties: {
              coordX: { type: 'number' },
              coordY: { type: 'number' }
            }
          }
        }
      },
      player: gumboPerson,
      startTime: { type: ['string', 'null'] },
      endTime: { type: ['string', 'null'] }
    }
  },
  GumboActionEvent: {
    type: 'object',
    required: ['index', 'isPitch', 'type', 'details'],
    properties: {
      index: { type: 'integer' },
      isPitch: { type: 'boolean', enum: [false] },
      isBaseRunningPlay: {
        type: 'boolean',
        description: 'Present, and true, only on a base-running action.'
      },
      isSubstitution: {
        type: 'boolean',
        description:
          'Present, and true, on a lineup change: `offensive_substitution`, ' +
          '`defensive_substitution`, `defensive_switch`, ' +
          "`pitching_substitution` or `ts_batting_order`. As in MLB's feed, " +
          "a side's changes to its fielders from when it leaves the field " +
          'to its first pitch back in it are written as their net change at ' +
          'the start of the first play it fields. A pinch hitter is written ' +
          'at the start of the first play he bats in, and a pinch runner ' +
          'where he takes the base. A `ts_batting_order` names only players ' +
          'who have appeared in play.'
      },
      type: { type: 'string', enum: ['action'] },
      details: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          event: { type: 'string' },
          eventType: gumboEventType,
          awayScore: { type: 'integer', description: 'After the action.' },
          homeScore: { type: 'integer', description: 'After the action.' },
          isScoringPlay: { type: 'boolean' },
          isOut: { type: 'boolean' },
          hasReview: { type: 'boolean' }
        }
      },
      count: gumboCount,
      player: gumboPerson,
      position: gumboPosition,
      battingOrder: {
        type: 'string',
        description:
          'On an offensive substitution and a defensive switch: the slot ' +
          'times 100 plus how many have come in at it, e.g. `601`.'
      },
      replacedPlayer: gumboPerson,
      startTime: { type: ['string', 'null'] },
      endTime: { type: ['string', 'null'] }
    }
  },
  GumboCurrentPlay: {
    type: 'object',
    description:
      'The at-bat in progress, kept on the game rather than as a play: a ' +
      '`GumboPlay` with `about.isComplete` false and no `result`, since it ' +
      'has no outcome yet. When the batter due is already on base (the ' +
      'inning ended on a runner) it carries only its place in the game and ' +
      'the `teamStation` record.',
    required: ['about'],
    properties: {
      about: {
        type: 'object',
        required: ['atBatIndex', 'isComplete'],
        properties: {
          atBatIndex: { type: 'integer' },
          inning: { type: ['integer', 'null'] },
          halfInning: {
            type: ['string', 'null'],
            enum: ['top', 'bottom', null]
          },
          isComplete: { type: 'boolean', enum: [false] }
        }
      },
      count: gumboCount,
      matchup: { type: 'object' },
      runners: {
        type: 'array',
        items: { $ref: '#/components/schemas/GumboRunner' }
      },
      playEvents: {
        type: 'array',
        items: {
          oneOf: [
            { $ref: '#/components/schemas/GumboPitchEvent' },
            { $ref: '#/components/schemas/GumboActionEvent' }
          ]
        }
      },
      teamStation: { $ref: '#/components/schemas/TeamStationRecord' }
    }
  },
  TeamStationRecord: {
    type: 'object',
    description:
      'TeamStation extension, on every play it scored and on the at-bat in ' +
      "progress: the scorer's action log the play is rebuilt from. " +
      '`setupBefore` is the lineups before it, `actions` the actions in the ' +
      "engine's own vocabulary, and `detail` the scorer's own picks and " +
      'estimates (trajectory, launch angle). Replay and undo read it; ' +
      '`npm run refold-scored-games` rebuilds the rest of the play from it.' +
      ' New records use `version` 3 with persistent numeric player ids and ' +
      'an append-only `tagOrder`, and name every lineup by its team id, ' +
      "never by home or away: `setupBefore.teams` holds each team's " +
      'lineup, and a lineup change names `teamId`, its `setup.teams`, and ' +
      'the team ids it `confirmed` or left `unseen`. Version 2 records name ' +
      'sides and are still read; historical version 1 records are read ' +
      'through their saved identity maps. Invalid or unsupported records are ' +
      'refused with 400. Scoring sessions preserve historical playback times ' +
      'and the server adds radar measurement provenance when necessary.',
    required: ['version', 'setupBefore', 'actions'],
    properties: {
      version: { type: 'integer', enum: [1, 2, 3] },
      setupBefore: { type: 'object' },
      actions: { type: 'array', items: { type: 'object' } },
      actionTimes: {
        type: 'array',
        items: { type: 'string', format: 'date-time' },
        description:
          "When each action was taken, on the server's clock (`GET /time`): " +
          'one ISO time per action, in the order of `actions`. Left out of a ' +
          'play scored before actions carried times, or holding an action ' +
          'with no time; such a play has only its `about.startTime` and ' +
          '`about.endTime`. A list that does not match `actions` in length ' +
          'is ignored when the play is read back.'
      },
      playbackTimes: {
        type: 'array',
        items: { type: 'string', format: 'date-time' },
        description:
          'Session-maintained historical action times for scoreboard playback. ' +
          'Radar category corrections can change actionTimes without moving playback.'
      },
      radarMeasurements: {
        type: 'object',
        readOnly: true,
        description:
          'Server-maintained measurement timestamps, indexed by play-event index ' +
          'and pitchSpeed or exitVelocity. Retained speeds are revalidated against ' +
          'the configured matching window even after the source log expires.'
      },
      detail: { type: 'object' }
    }
  }
}

export function openApiDocument(version: string): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'TeamStation',
      version,
      description:
        'Teams, games, videos and the plays underneath them. Every failure ' +
        'answers with the same shape, and every request and response is ' +
        'checked by a cleaner on both sides.'
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' }
      },
      schemas: {
        ...gumboSchemas,
        BattingRow: battingSchema,
        PitchingRow: pitchingSchema,
        StandingsRow: standingsSchema,
        SeasonStats: {
          type: 'object',
          required: ['seasonId', 'batting', 'pitching'],
          properties: {
            seasonId: { type: 'string' },
            batting: {
              type: 'array',
              items: { $ref: '#/components/schemas/BattingRow' }
            },
            pitching: {
              type: 'array',
              items: { $ref: '#/components/schemas/PitchingRow' }
            }
          }
        },
        ApiError: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'badRequest',
                'unauthorized',
                'forbidden',
                'notFound',
                'conflict',
                'gone',
                'tooLarge',
                'unsupportedMedia',
                'rateLimited',
                'membersOnly',
                'internal',
                'unavailable'
              ]
            },
            message: { type: 'string' },
            details: {}
          }
        },
        Health: {
          type: 'object',
          required: ['status', 'version', 'database', 'migrations'],
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            version: { type: 'string' },
            database: { type: 'string', enum: ['ok', 'unreachable'] },
            migrations: { type: 'integer' },
            uptimeSec: { type: 'integer' },
            pid: { type: 'integer' },
            dictation: {
              type: 'boolean',
              description: 'Whether dictation is configured on this server'
            },
            dictationModels: {
              type: 'array',
              items: { type: 'string' },
              description: 'The LLMs dictation has a key for on this server'
            },
            narration: {
              type: 'boolean',
              description:
                "Whether the replay's announcer can speak on this server"
            },
            tess: {
              type: 'boolean',
              description:
                'Whether Tess, the assistant, is available on this server'
            },
            replayPitchSec: {
              type: 'integer',
              minimum: 1,
              maximum: 600,
              description:
                'How long a replay holds each pitch, in seconds: the node setting, 5 unless a node administrator set another'
            }
          }
        },
        User: {
          type: 'object',
          required: ['id', 'gumboId', 'displayName', 'isAdmin'],
          properties: {
            id: userIdSchema,
            gumboId: nullableGumboIdSchema,
            displayName: { type: 'string' },
            email: { type: ['string', 'null'] },
            isAdmin: { type: 'boolean' },
            onboarding: {
              type: 'object',
              required: ['step', 'completedAt'],
              properties: {
                step: { type: 'string', enum: ['name', 'photo', 'complete'] },
                completedAt: { type: ['string', 'null'], format: 'date-time' }
              }
            }
          }
        },
        LiveStream: {
          type: 'object',
          required: ['gameId', 'exists'],
          description:
            'A game\u2019s live stream. `url` is present only in the reply to ' +
            'a request that asked for it by name \u2014 creating, revealing ' +
            'or rotating \u2014 because it carries the key, and anybody ' +
            'holding that can publish video into this game.',
          properties: {
            gameId: { type: 'string' },
            exists: { type: 'boolean' },
            id: { type: 'string' },
            teamId: { type: 'string' },
            keyPrefix: {
              type: 'string',
              description:
                'Enough to tell two keys apart, far too little to use'
            },
            state: {
              type: 'string',
              enum: ['idle', 'publishing', 'ended', 'revoked']
            },
            opensAt: { type: 'string', format: 'date-time' },
            closesAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description:
                'When somebody ended it. Null while it is still good — a key ' +
                'has no clock at either end, so it can be tried before the ' +
                'game and after it.'
            },
            videoId: { type: ['string', 'null'] },
            lastError: { type: ['string', 'null'] },
            status: {
              type: ['object', 'null'],
              description:
                'What the ingest last reported: the stream arriving, and each ' +
                'leg it is being sent to. Never carries a key.'
            },
            deviceModel: {
              type: ['string', 'null'],
              description:
                'What the device holding it is, in words. On every item of ' +
                'a game\u2019s list, and on a single device stream; null for ' +
                'a browser\u2019s or streaming software\u2019s stream'
            },
            deviceId: {
              type: ['string', 'null'],
              description:
                'The install holding it, on the owner\u2019s own streams only'
            },
            localRecording: {
              type: 'string',
              enum: ['none', 'recorded', 'uploaded'],
              description:
                'How far the phone\u2019s own recording of it has got. ' +
                '`uploaded`: the upload stands in for its live copy'
            },
            url: {
              type: 'string',
              description: 'The whole thing, key and all, for pasting'
            }
          }
        },
        Invite: {
          type: 'object',
          required: ['id', 'code', 'url', 'scopeType', 'scopeId', 'uses'],
          description:
            'A standing offer to let somebody watch a league, a season or a ' +
            'team. `url` is the address to hand out, which is the same ' +
            '`/i/<code>` path PeerTube used so that links already in ' +
            'mailboxes keep working.',
          properties: {
            id: { type: 'string' },
            code: { type: 'string' },
            url: { type: 'string' },
            scopeType: { type: 'string', enum: ['league', 'season', 'team'] },
            scopeId: { type: 'string' },
            label: { type: ['string', 'null'] },
            maxUses: { type: ['integer', 'null'] },
            uses: { type: 'integer' },
            expiresAt: { type: ['string', 'null'], format: 'date-time' },
            revokedAt: { type: ['string', 'null'], format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            problem: {
              type: ['string', 'null'],
              enum: ['revoked', 'expired', 'exhausted', null],
              description: 'Why it no longer works, or null while it does'
            }
          }
        },
        InviteInfo: {
          type: 'object',
          required: ['code', 'valid', 'scope', 'signedIn', 'alreadyIn'],
          description: 'What is behind a code, for the screen its link opens.',
          properties: {
            code: { type: 'string' },
            valid: { type: 'boolean' },
            problem: {
              type: ['string', 'null'],
              enum: ['revoked', 'expired', 'exhausted', null]
            },
            scope: {
              type: 'object',
              required: ['kind', 'id', 'name'],
              properties: {
                kind: { type: 'string', enum: ['league', 'season', 'team'] },
                id: { type: 'string' },
                name: { type: 'string' }
              }
            },
            signedIn: { type: 'boolean' },
            alreadyIn: { type: 'boolean' }
          }
        },
        ScopePerson: {
          type: 'object',
          required: ['userId', 'displayName', 'emails', 'createdAt'],
          description:
            'One person with access, and every level it comes through. Never ' +
            'the strongest grant alone: somebody often holds two, and an ' +
            'administrator who removes one and sees nothing change has been ' +
            'told a half-truth.',
          properties: {
            userId: userIdSchema,
            displayName: { type: 'string' },
            emails: { type: 'array', items: { type: 'string' } },
            teams: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            seasons: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            leagues: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopeGrant' }
            },
            grants: {
              type: 'array',
              description:
                'Every role they hold in this tree, one entry per level. A ' +
                'role set above the level being managed appears under that ' +
                'level, with its name.',
              items: { $ref: '#/components/schemas/RoleGrant' }
            },
            adminOf: {
              type: 'array',
              description:
                '`grants` narrowed to `admin`, for apps from before the ' +
                'role flags.',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['league', 'season', 'team']
                  },
                  id: { type: 'string' },
                  name: { type: 'string' }
                }
              }
            },
            createdAt: { type: 'string', format: 'date-time' },
            lastSignInAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'Null for an account nobody has ever used'
            },
            lastSeenAt: {
              type: ['string', 'null'],
              format: 'date-time',
              description:
                'The last request on any of their sessions, which is later ' +
                'than the sign-in for anybody who stays signed in'
            }
          }
        },
        LineupPerson: {
          type: 'object',
          required: ['gumboId', 'name', 'jersey'],
          description:
            'A player in a lineup: his scoring id, or null for a placeholder ' +
            'named at the field, the short name the scoring screen shows ' +
            '(never a full name), and his jersey. The name of a player with ' +
            'an id is read from his account when the lineup is read, so it ' +
            'follows a rename; a placeholder keeps the name typed for him.',
          properties: {
            gumboId: { type: ['integer', 'null'] },
            name: { type: 'string' },
            jersey: { type: 'string' }
          }
        },
        Lineup: {
          type: 'object',
          required: ['batters', 'defense'],
          properties: {
            batters: {
              type: 'array',
              description: 'The batting order; the first leads off.',
              items: { $ref: '#/components/schemas/LineupPerson' }
            },
            defense: {
              type: 'object',
              description:
                'Each position, P, C, 1B, 2B, SS, 3B, LF, CF and RF, and who ' +
                'plays it, or null.',
              additionalProperties: {
                oneOf: [
                  { $ref: '#/components/schemas/LineupPerson' },
                  { type: 'null' }
                ]
              }
            }
          }
        },
        LineupChange: {
          type: 'object',
          required: [
            'atBatIndex',
            'inning',
            'half',
            'side',
            'eventType',
            'player',
            'position',
            'battingOrder',
            'replaced',
            'description'
          ],
          description:
            'One stored Gumbo substitution event, announced in the play at ' +
            '`atBatIndex` where MLB announces it: a pinch hitter in the play ' +
            'he bats in, a pinch runner where he takes the base, and a ' +
            "side's fielding changes at the start of the first play it fields.",
          properties: {
            atBatIndex: { type: 'integer' },
            inning: { type: 'integer' },
            half: { type: 'string', enum: ['top', 'bottom'] },
            side: {
              type: 'string',
              enum: ['away', 'home'],
              description: 'The side the player belongs to'
            },
            eventType: {
              type: 'string',
              enum: [
                'offensive_substitution',
                'defensive_substitution',
                'defensive_switch',
                'pitching_substitution',
                'ts_batting_order'
              ]
            },
            player: { $ref: '#/components/schemas/LineupPerson' },
            position: {
              type: ['string', 'null'],
              description: 'The Gumbo abbreviation: PH, PR, SS, P, …'
            },
            battingOrder: {
              type: ['string', 'null'],
              description: 'The place in the order as MLB writes it, `601`'
            },
            replaced: {
              oneOf: [
                { $ref: '#/components/schemas/LineupPerson' },
                { type: 'null' }
              ]
            },
            description: { type: 'string' }
          }
        },
        SideLineups: {
          type: 'object',
          required: ['teamId', 'teamName', 'start', 'changes', 'current'],
          properties: {
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            start: {
              description:
                'The lineup the side began with; null until the game has ' +
                'begun, and for a game TeamStation did not score.',
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            },
            changes: {
              type: 'array',
              items: { $ref: '#/components/schemas/LineupChange' }
            },
            current: {
              description:
                'The lineup as it stands, including a change not announced ' +
                'yet, such as a pinch hitter waiting to bat. Null for a game ' +
                'TeamStation did not score, or whose record no longer replays.',
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            }
          }
        },
        GameLineups: {
          type: 'object',
          required: ['away', 'home', 'digest'],
          properties: {
            away: { $ref: '#/components/schemas/SideLineups' },
            home: { $ref: '#/components/schemas/SideLineups' },
            digest: {
              type: 'string',
              description:
                "The digest the game keeps of both sides' lineups, which " +
                'changes exactly when what they show does. The game socket ' +
                'sends the same with each `lineups` change, so a screen ' +
                'tells its own save from somebody else’s.'
            },
            generation: {
              type: 'integer',
              description:
                'The game’s play generation, one more after each reset: a ' +
                'save naming another is refused with 409.'
            }
          }
        },
        DjSide: {
          type: 'object',
          required: [
            'teamId',
            'teamName',
            'source',
            'canEditWalkUp',
            'batters'
          ],
          properties: {
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            source: {
              description:
                "Where the order came from: the game's own lineup as it " +
                "stands, the team's default before the game has one, or its " +
                'players by jersey number when it has neither.',
              enum: ['lineup', 'default', 'roster']
            },
            canEditWalkUp: {
              type: 'boolean',
              description: "Whether the caller keeps this team's walk-up songs."
            },
            batters: {
              type: 'array',
              items: {
                type: 'object',
                required: ['userId', 'name', 'walkUpSong'],
                properties: {
                  userId: {
                    description: 'Null for a placeholder named at the field.',
                    oneOf: [userIdSchema, { type: 'null' }]
                  },
                  name: { type: 'string' },
                  walkUpSong: {
                    oneOf: [
                      { $ref: '#/components/schemas/WalkUpSong' },
                      { type: 'null' }
                    ]
                  }
                }
              }
            }
          }
        },
        DefaultLineup: {
          type: 'object',
          required: ['lineup', 'fromGameId', 'setAt'],
          description:
            "A team's default lineup, or all three null for a team with none.",
          properties: {
            lineup: {
              oneOf: [{ $ref: '#/components/schemas/Lineup' }, { type: 'null' }]
            },
            fromGameId: { type: ['string', 'null'] },
            setAt: { type: ['string', 'null'], format: 'date-time' }
          }
        },
        Role: {
          type: 'string',
          enum: [
            'admin',
            'coach',
            'assistant',
            'scorekeeper',
            'songkeeper',
            'videographer'
          ],
          description:
            'What somebody may do on a league, season or team and everything ' +
            'inside it. `admin` holds every flag without having one set. ' +
            '`assistant` may do everything `coach` may, and `scorekeeper` ' +
            'everything `songkeeper` may.'
        },
        WalkUpSong: {
          type: 'object',
          required: [
            'provider',
            'providerId',
            'title',
            'artist',
            'durationMs',
            'startMs',
            'endMs'
          ],
          description:
            "A player's walk-up song on one team, and the clip of it that " +
            `plays: \`startMs\` to \`endMs\`, within \`durationMs\`, ` +
            `${CLIP_MIN_MS / 1000} to ${CLIP_MAX_MS / 1000} seconds long. ` +
            'Text is trimmed; an empty optional field is null.',
          properties: {
            provider: { type: 'string', enum: [...WALK_UP_PROVIDERS] },
            providerId: {
              type: 'string',
              description:
                'The Apple Music catalog id, or for a file on a phone `lf:` ' +
                'and the first 16 hex characters of a sha256 of its ' +
                'normalised title, artist and whole-second duration.'
            },
            isrc: {
              type: ['string', 'null'],
              description: 'Read without hyphens, in capitals.'
            },
            title: { type: 'string', maxLength: 300 },
            artist: { type: 'string', maxLength: 300 },
            album: { type: ['string', 'null'], maxLength: 300 },
            artworkUrl: {
              type: ['string', 'null'],
              description: 'An http or https address.'
            },
            durationMs: { type: 'integer', minimum: 1 },
            startMs: { type: 'integer', minimum: 0 },
            endMs: { type: 'integer' }
          }
        },
        PlayerTeam: {
          type: 'object',
          required: [
            'teamId',
            'teamName',
            'seasonId',
            'seasonName',
            'seasonYear',
            'jersey',
            'positions',
            'current',
            'logoUrl'
          ],
          description:
            'A team a player has played for, once for each season it is in, ' +
            'belongs to or played in. `jersey` and `positions` are their ' +
            'membership’s, null and empty on a team they only have stats ' +
            'for. `current` is whether they are a player on it now, under any ' +
            'of their rows: false on a team they have left.',
          properties: {
            teamId: { type: 'string' },
            teamName: { type: 'string' },
            seasonId: { type: ['string', 'null'] },
            seasonName: { type: ['string', 'null'] },
            seasonYear: { type: ['integer', 'null'] },
            jersey: { type: ['string', 'null'] },
            positions: { type: 'array', items: { type: 'string' } },
            current: { type: 'boolean' },
            logoUrl: {
              type: ['string', 'null'],
              description: "The team's logo, a signed URL; null without one."
            }
          }
        },
        RosterEntry: {
          type: 'object',
          required: [
            'userId',
            'gumboId',
            'shortName',
            'avatarUrl',
            'jersey',
            'positions',
            'isPlayer',
            'role',
            'bats',
            'throws',
            'section',
            'staffRoles',
            'inheritedFrom',
            'walkUpSong'
          ],
          description:
            'One person on a team\u2019s roster. Somebody listed without a ' +
            'membership of the team (staff given their role on its season ' +
            'or league, a member of its season or league, a guardian of one ' +
            'of its players, or a follower) has `role` `member`, `isPlayer` ' +
            'false, no jersey, no positions and no walk-up song.',
          properties: {
            userId: userIdSchema,
            gumboId: {
              type: ['integer', 'null'],
              minimum: 1,
              maximum: 9007199254740991
            },
            shortName: {
              type: 'string',
              description: PUBLIC_NAME
            },
            nameDetails: {
              type: 'object',
              required: ['firstName', 'lastName', 'displayName'],
              description:
                'A player\u2019s whole name, only on a read with ' +
                '`includeFullNames=true` by a roster manager.',
              properties: {
                firstName: { type: ['string', 'null'] },
                lastName: { type: ['string', 'null'] },
                displayName: { type: 'string' }
              }
            },
            avatarUrl: { type: ['string', 'null'] },
            jersey: { type: ['string', 'null'] },
            positions: { type: 'array', items: { type: 'string' } },
            isPlayer: { type: 'boolean' },
            role: {
              type: 'string',
              description: 'Their membership: `owner`, `manager` or `member`.'
            },
            bats: {
              type: ['string', 'null'],
              enum: ['left', 'right', 'switch', null]
            },
            throws: { type: ['string', 'null'], enum: ['left', 'right', null] },
            section: {
              type: 'string',
              enum: [
                'admin',
                'staff',
                'player',
                'family',
                'spectator',
                'follower'
              ],
              description:
                'The first that fits: `admin` (owner, manager, or the ' +
                'admin role on the team, its season or its league), ' +
                '`staff` (any role flag there), `player`, `family` (a ' +
                'guardian of one of its players), `spectator` (a member of ' +
                'the team, its season or its league), `follower` (follows ' +
                'the team, or a team merged into it).'
            },
            staffRoles: {
              type: 'array',
              items: { $ref: '#/components/schemas/RoleFlag' },
              description:
                'The flags given on the team, its season or its league, in ' +
                'flag order. Implied roles are not listed.'
            },
            inheritedFrom: {
              description:
                'For the role that placed them (`admin`, the first of ' +
                '`staffRoles`, or for a spectator `member`), the highest ' +
                'level giving it when that is above the team: a team coach ' +
                'who also coaches the league is `{ level: league, role: ' +
                'coach }`, and a member of the team\u2019s season `{ level: ' +
                'season, role: member }`. Null when the team gives it, and ' +
                'for players, family and followers.',
              oneOf: [
                {
                  type: 'object',
                  required: ['level', 'role'],
                  properties: {
                    level: { type: 'string', enum: ['season', 'league'] },
                    role: {
                      oneOf: [
                        { $ref: '#/components/schemas/Role' },
                        { type: 'string', enum: ['member'] }
                      ]
                    }
                  }
                },
                { type: 'null' }
              ]
            },
            walkUpSong: {
              oneOf: [
                { $ref: '#/components/schemas/WalkUpSong' },
                { type: 'null' }
              ]
            },
            teamNames: {
              type: 'array',
              items: { type: 'string' },
              description:
                'On a season\u2019s or league\u2019s people list, the teams ' +
                'a player plays on there. Absent from a team\u2019s roster.'
            },
            guardianOf: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For a family member, the short names of the players on this ' +
                'list they are a parent or guardian of. Absent for everybody ' +
                'else.'
            }
          }
        },
        PersonProfile: {
          type: 'object',
          required: ['context', 'person', 'guardianOf', 'sections', 'viewer'],
          description:
            'One person as a team, season or league sees them, for the ' +
            'profile opened from its people list.',
          properties: {
            context: {
              type: 'object',
              required: ['kind', 'id', 'name'],
              properties: {
                kind: { type: 'string', enum: ['league', 'season', 'team'] },
                id: { type: 'string' },
                name: { type: 'string' }
              }
            },
            person: {
              type: 'object',
              required: [
                'userId',
                'shortName',
                'fullName',
                'avatarUrl',
                'canHoldRoles'
              ],
              properties: {
                userId: userIdSchema,
                shortName: { type: 'string' },
                fullName: {
                  type: ['string', 'null'],
                  description:
                    'For a viewer who manages the level\u2019s people, or ' +
                    'may read the whole name anyway; null for anybody else.'
                },
                avatarUrl: { type: ['string', 'null'] },
                canHoldRoles: {
                  type: 'boolean',
                  description:
                    'An account that signs in, not suspended or closed: ' +
                    'only such a person is given a role.'
                }
              }
            },
            guardianOf: {
              type: 'array',
              description:
                'The players they guard who play now on a team the level ' +
                'reaches (the team; any team of the season; any team of ' +
                'the league), each with the first such team by name.',
              items: {
                type: 'object',
                required: ['userId', 'shortName', 'avatarUrl', 'teamId'],
                properties: {
                  userId: userIdSchema,
                  shortName: { type: 'string' },
                  avatarUrl: { type: ['string', 'null'] },
                  teamId: { type: 'string' }
                }
              }
            },
            sections: {
              type: 'array',
              description:
                'A team\u2019s profile: the team, all its seasons as one, ' +
                'its league. A season\u2019s: the season and its league. A ' +
                'league\u2019s: the league. A level with no group is left ' +
                'out. `roles` and `member` are what was given at that level ' +
                'itself; `editable` is true only for the level the profile ' +
                'is opened from, for a viewer who manages its people.',
              items: {
                type: 'object',
                required: [
                  'level',
                  'groups',
                  'roles',
                  'member',
                  'follower',
                  'editable'
                ],
                properties: {
                  level: {
                    type: 'string',
                    enum: ['league', 'season', 'team']
                  },
                  groups: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'name'],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' }
                      }
                    }
                  },
                  roles: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Role' }
                  },
                  member: { type: 'boolean' },
                  follower: { type: 'boolean' },
                  editable: { type: 'boolean' }
                }
              }
            },
            viewer: {
              type: 'object',
              required: ['manages', 'admin'],
              properties: {
                manages: {
                  type: 'boolean',
                  description:
                    'An administrator, coach or assistant of the level.'
                },
                admin: {
                  type: 'boolean',
                  description: 'An administrator of it, who changes Admin.'
                }
              }
            }
          }
        },
        HeldAt: {
          type: 'object',
          required: ['userId', 'roles', 'member'],
          description: 'What somebody holds at one level itself, now.',
          properties: {
            userId: userIdSchema,
            roles: {
              type: 'array',
              items: { $ref: '#/components/schemas/Role' }
            },
            member: { type: 'boolean' }
          }
        },
        RoleFlag: {
          type: 'string',
          enum: [
            'coach',
            'assistant',
            'scorekeeper',
            'songkeeper',
            'videographer'
          ]
        },
        RoleGrant: {
          type: 'object',
          required: ['kind', 'id', 'name', 'roles'],
          properties: {
            kind: { type: 'string', enum: ['league', 'season', 'team'] },
            id: { type: 'string' },
            name: { type: 'string' },
            roles: {
              type: 'array',
              items: { $ref: '#/components/schemas/Role' }
            }
          }
        },
        ScopeGrant: {
          type: 'object',
          required: ['id', 'name', 'role'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            isPlayer: {
              type: 'boolean',
              description:
                'For team memberships, whether this person is on the player roster. Independent of email or login status.'
            }
          }
        },
        PendingPerson: {
          type: 'object',
          required: ['inviteId', 'email', 'code', 'invitedAt'],
          description:
            'Somebody invited by address who has not opened the link yet.',
          properties: {
            inviteId: { type: 'string' },
            email: { type: 'string' },
            code: { type: 'string' },
            invitedAt: { type: 'string', format: 'date-time' },
            requestId: {
              type: 'string',
              description:
                'The shared request referenced by the email link and inbox'
            }
          }
        },
        ManagePage: {
          type: 'object',
          required: ['scope', 'tree', 'people', 'pending', 'invites'],
          properties: {
            scope: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['league', 'season', 'team'] },
                id: { type: 'string' },
                name: { type: 'string' },
                safesportLao: {
                  type: 'boolean',
                  description:
                    'A league only: whether it is a SafeSport Local ' +
                    'Affiliated Organization, bound by the MAAPP'
                }
              }
            },
            tree: {
              type: 'object',
              description:
                'The levels around this one, named, so a tick can say which',
              properties: {
                leagues: { type: 'array', items: namedThing },
                seasons: { type: 'array', items: namedThing },
                teams: { type: 'array', items: namedThing }
              }
            },
            people: {
              type: 'array',
              items: { $ref: '#/components/schemas/ScopePerson' }
            },
            pending: {
              type: 'array',
              items: { $ref: '#/components/schemas/PendingPerson' }
            },
            invites: {
              type: 'array',
              items: { $ref: '#/components/schemas/Invite' }
            }
          }
        },
        Session: {
          type: 'object',
          required: ['token', 'expiresAt', 'user'],
          properties: {
            next: {
              type: 'string',
              description:
                'Optional local return path from the original sign-in request, including its query string. Returned when claiming an email link or its approved request.'
            },
            token: {
              type: 'string',
              description: 'Shown once. Only its hash is stored.'
            },
            expiresAt: { type: 'string', format: 'date-time' },
            user: { $ref: '#/components/schemas/User' }
          }
        }
      }
    },
    paths: {
      ...creationPaths(errorResponse),
      ...gameApprovalPaths(errorResponse),
      ...umpirePaths(errorResponse),
      ...tessPaths(errorResponse),
      ...venuePaths(errorResponse),
      ...schedulingSetupPaths(errorResponse),
      ...schedulePreviewPaths(errorResponse),
      ...eventInfoPaths(errorResponse),
      ...accountPaths,
      ...apiKeyPaths,
      ...graphqlPaths,
      '/me/builds': {
        get: {
          summary: 'Read the optional build distribution link',
          description:
            'Human sessions only. The distribution service independently decides access. An absent URL means no link should be shown.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Optional HTTPS URL' },
            401: { description: 'Active human session required' }
          }
        }
      },
      '/device-event-control/key': {
        get: {
          summary: "Read the caller's device event-control key",
          description:
            "Human sessions only; a machine API token gets 401. The key lets devices signed in to the same account on this server authenticate the local event-control protocol, in which a Director sets the publishing event of nearby devices. It is derived from the caller's own user ID and this server's origin, is never accepted as a bearer token, and changes when the server rotates its secret (the key ID changes with it). Not cached (`Cache-Control: no-store`).",
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The account scope and its key',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'version',
                      'issuer',
                      'userId',
                      'accountTag',
                      'keyId',
                      'key'
                    ],
                    properties: {
                      version: { type: 'integer', enum: [2] },
                      issuer: {
                        type: 'string',
                        description: "The server's canonical public origin"
                      },
                      userId: userIdSchema,
                      accountTag: {
                        type: 'string',
                        description:
                          'Opaque, equal for every device of the account: 32 hex characters'
                      },
                      keyId: {
                        type: 'string',
                        description:
                          'Names the server secret the key came from: 16 hex characters'
                      },
                      key: {
                        type: 'string',
                        description: 'HMAC-SHA256 key: 64 hex characters'
                      }
                    }
                  }
                }
              }
            },
            401: { description: 'Active human session required' },
            503: {
              description:
                'Not set up on this server: `{ code: "unavailable", error: "deviceEventControlUnavailable" }`'
            }
          }
        }
      },
      '/oauth/approvals/{handle}': {
        get: {
          summary: 'Read an OAuth request to approve in the mobile app',
          description:
            'Requires an active human session. Available when OAuth is configured. The opaque handle expires after five minutes.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'handle',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description:
                'Registered client name, requested scopes, decision and browser resume URL'
            },
            400: { description: 'Expired or unavailable approval' },
            401: { description: 'An active human session is required' }
          }
        },
        post: {
          summary: 'Approve or deny an OAuth request from the mobile app',
          description:
            'Requires a human Bearer session and no browser Origin header. The decision is single-use; only the initiating browser can complete authorization.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'handle',
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
                  type: 'object',
                  required: ['approve'],
                  additionalProperties: false,
                  properties: { approve: { type: 'boolean' } }
                }
              }
            }
          },
          responses: {
            200: { description: 'Decision saved; resume the original browser' },
            400: {
              description: 'Invalid, expired or already decided approval'
            },
            401: { description: 'An active human session is required' },
            403: { description: 'Native Bearer authorization is required' }
          }
        }
      },
      '/me/onboarding': {
        get: {
          summary: 'Resume your account name and photo onboarding',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Display name and saved onboarding state' },
            401: errorResponse
          }
        }
      },
      '/me/onboarding/name': {
        put: {
          summary: 'Save your required name before the photo step',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['displayName'],
                  properties: {
                    displayName: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Name saved; photo is the next step' },
            400: errorResponse,
            401: errorResponse,
            409: errorResponse
          }
        }
      },
      '/me/onboarding/photo': {
        put: {
          summary: 'Save your picture or initials and complete onboarding',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    catalogId: { type: 'string' },
                    image: {
                      type: 'object',
                      required: ['contentType', 'base64'],
                      properties: {
                        contentType: {
                          type: 'string',
                          enum: ['image/jpeg', 'image/png', 'image/webp']
                        },
                        base64: { type: 'string', contentEncoding: 'base64' }
                      }
                    },
                    initials: { type: 'boolean', const: true }
                  },
                  oneOf: [
                    { required: ['catalogId'] },
                    { required: ['image'] },
                    { required: ['initials'] }
                  ]
                }
              }
            }
          },
          responses: {
            200: { description: 'Onboarding complete' },
            400: errorResponse,
            401: errorResponse,
            409: errorResponse
          }
        }
      },
      '/pictures': {
        get: {
          summary: 'Reusable sports pictures and creation icon renditions',
          responses: {
            200: {
              description:
                'Versioned entries with stable ids and short-lived rendition URLs'
            },
            503: errorResponse
          }
        }
      },
      '/me/account/catalog-picture': {
        put: {
          summary: 'Select a shared picture for your own account',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['catalogId'],
                  properties: { catalogId: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            200: { description: 'Picture reference saved' },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/locations': {
        get: {
          summary: 'Search public city and region reference data',
          description:
            'Omitting kind keeps the city-reference response. Authenticated venue/address searches return up to five {id,name,address} suggestions, provider and attribution. Google Places is primary when configured; unavailable Google uses OpenStreetMap/Photon fallback. Valid empty Google results stay empty. Venue mode suggests named points of interest rather than streets or house numbers. Free text remains valid if lookup fails.',
          parameters: [
            {
              name: 'session',
              in: 'query',
              schema: { type: 'string', maxLength: 64 },
              description:
                'Optional city search session. Omit for the legacy GeoNames response; signed-in sessions use Google when configured.'
            },
            {
              name: 'query',
              in: 'query',
              required: true,
              schema: { type: 'string', maxLength: 120 },
              description:
                'City, region and/or country, or place/address when kind is supplied; blank returns no suggestions'
            },
            {
              name: 'kind',
              in: 'query',
              schema: { type: 'string', enum: ['venue', 'address'] },
              description:
                'Optional; omitted defaults to local city-reference search.'
            }
          ],
          responses: {
            200: {
              description:
                'Legacy places plus suggestions {id,primary,secondary}, provider and attribution. Google sessions return city-only suggestions.'
            },
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
            503: errorResponse
          }
        }
      },
      '/locations/{id}': {
        get: {
          summary: 'Resolve a city reference',
          description:
            'Google IDs require a signed-in caller. GeoNames references are public. The locality retains its time zone without coordinates.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'google:<placeId> or geonames:<catalogueId>'
            },
            {
              name: 'session',
              in: 'query',
              schema: { type: 'string', maxLength: 64 },
              description: 'Optional autocomplete session token'
            }
          ],
          responses: {
            200: {
              description: 'A place: {city,region,country,placeId,timezone}'
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            422: errorResponse,
            429: errorResponse,
            503: errorResponse
          }
        }
      },
      '/location-suggestions': {
        post: {
          summary: 'Suggest a city from a transient location estimate',
          description:
            'Only the public locality is returned. Device coordinates are not retained or attached to audit records.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latitude', 'longitude'],
                  properties: {
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Suggested locality, or null, with attribution'
            },
            400: errorResponse
          }
        }
      },
      '/health': {
        get: {
          summary:
            'Whether this worker can serve, and whether it can see the database',
          responses: {
            200: {
              description: 'Healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' }
                }
              }
            },
            503: {
              description: 'The database is unreachable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' }
                }
              }
            }
          }
        }
      },
      '/time': {
        get: {
          summary: "The server's clock",
          description:
            'Needs no sign-in, and answers with `Cache-Control: no-store`. ' +
            "A device measures how far its clock is from the server's with " +
            'it — from the reading that comes back quickest, taking `now` as ' +
            'read halfway through — and stamps each scoring action with its ' +
            "own clock plus that offset, so every device's moments are on one " +
            'clock.',
          responses: {
            200: {
              description: "The server's clock",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['now'],
                    properties: {
                      now: {
                        type: 'integer',
                        description: 'Milliseconds since the epoch.'
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/auth/password/parameters': {
        post: {
          summary: 'Get client Argon2id parameters for password sign-in',
          description:
            'Apply these saved parameters to UTF-8 password bytes on the client. Unknown or unavailable credentials return a decoy; no final hash or server salt is exposed.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string', maxLength: 254 } }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Client parameters',
              content: { 'application/json': { schema: argonParameters } }
            },
            429: errorResponse
          }
        }
      },
      '/auth/password': {
        post: {
          summary: 'Sign in with an e-mail address and a password',
          description:
            'An address of an account that has been merged into another ' +
            'signs in to the account it was merged into (following every ' +
            'merge after it), with that account\u2019s password; the merged ' +
            'account\u2019s own password no longer signs anybody in.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'clientHash'],
                  properties: {
                    email: { type: 'string' },
                    clientHash: clientHashSchema
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Signed in',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/email-code': {
        post: {
          summary: 'Ask for a sign-in code by e-mail',
          description:
            'Always answers 202, whether or not the address has an account, ' +
            'so this cannot be used to find out who is registered. The code ' +
            'goes to the address given, also when its account has been ' +
            'merged into another.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string' },
                    origin: {
                      type: 'string',
                      enum: ['web', 'ios', 'android'],
                      default: 'web'
                    },
                    next: {
                      type: 'string',
                      description: 'Where to go once signed in'
                    },
                    appOrigin: {
                      type: 'string',
                      description:
                        'The link host of the app asking (an origin such as ' +
                        '`https://app1.example.test`), so the link in the ' +
                        'e-mail opens that app and names this server in ' +
                        '`server`. Must be one of the apps this server is ' +
                        'configured to sign in; any other value is refused ' +
                        'with 400. Absent on the web, where the link stays ' +
                        'on this server.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            202: {
              description: 'A code was sent if there was somebody to send it to'
            },
            400: errorResponse
          }
        }
      },
      '/auth/email-code/verify': {
        post: {
          summary: 'Exchange an e-mailed code for a session',
          description:
            'An address of an account that has been merged into another ' +
            'signs in to the account it was merged into (following every ' +
            'merge after it), and the session is that account\u2019s.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'code'],
                  properties: {
                    email: { type: 'string' },
                    code: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Signed in',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/logout': {
        post: {
          summary: 'Revoke the session this request used',
          security: [{ bearer: [] }],
          responses: { 204: { description: 'Revoked' }, 401: errorResponse }
        }
      },
      '/me/roles': {
        get: {
          summary: 'What the caller may do, team by team',
          description:
            'Every team on which the caller holds any role, with the roles ' +
            'they hold there: set on the team, carried down from its season ' +
            'or league, every role on a team they administer, and ' +
            '`songkeeper` wherever they are `scorekeeper`. A site ' +
            'admin holds every role on every team. `guardianOf` lists the ' +
            'players the caller is a guardian of (a `guardian` or `family` ' +
            'link), by the user id each now signs in as.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The roles on each team',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['teams', 'guardianOf'],
                    properties: {
                      teams: {
                        type: 'object',
                        additionalProperties: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Role' }
                        }
                      },
                      guardianOf: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: 'Player user ids, in id order'
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/me': {
        get: {
          summary: 'Who this token belongs to',
          description:
            'A token is refused with 401, as an expired one is, once its ' +
            'account has been merged into another: a merge signs the merged ' +
            'account out of every session, machine token and OAuth grant. ' +
            'Signing in again with either account\u2019s address reaches the ' +
            'account that was kept.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The signed-in user',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/User' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/teams': {
        get: {
          summary: 'The teams this person belongs to, or a season\u2019s teams',
          description:
            'Without `season`: regular teams only, never an opponent from ' +
            'outside a season. A site administrator gets every team; anybody ' +
            'else the teams they may see.\n\n' +
            '`season` may be repeated, and lists the teams of those seasons ' +
            'instead, whoever the caller belongs to: its regular teams, and ' +
            'with `kind=external` or `kind=any` the placeholder teams on either ' +
            'side of its games (`kind=external` lists only those). A season ' +
            'the caller can neither see nor schedule games in answers 404. A ' +
            'merged team is listed as the team it was merged into, and each ' +
            'team once. `kind` defaults to `full`; any other value needs ' +
            '`season` (400 `kind needs season`).\n\n' +
            'Each team carries `externalIds`, the ids other systems know it ' +
            'by (any system or kind), sorted, and `kind`, `full` or ' +
            '`external`. `externalId` may be repeated, and narrows the list ' +
            'to teams holding any of those ids, with what the caller may see ' +
            'unchanged; an empty one is refused.',
          security: [{}, { bearer: [] }],
          parameters: [
            {
              name: 'view',
              in: 'query',
              schema: { type: 'string', enum: ['public'] },
              description:
                'Public minimal summaries without private scope. Omitted keeps the authenticated private collection.'
            },
            {
              name: 'query',
              in: 'query',
              schema: { type: 'string', maxLength: 120, default: '' },
              description:
                'Public discovery by group name, city or region; used with ' +
                'view=public. Each public team row also carries ' +
                '`seasonNames`, the seasons it is in, newest first, and ' +
                '`staffNames`, its staff as public short names (`First L.`), ' +
                'coaches first; nobody who has not named themselves yet.'
            },
            {
              name: 'relatedTeam',
              in: 'query',
              schema: { type: 'string', maxLength: 120 },
              description:
                'Suggests the teams a game against this team is likely to ' +
                'be with, at most 50: the same season, the same league, ' +
                'opponents within six months, then the same region, each ' +
                'team once and never this one or a merged team. Needs ' +
                '`view=public` (400) and an empty `query` (400 `relatedTeam ' +
                'and relatedSeason do not combine with query`); an unknown ' +
                'team answers 404. Leaving it out keeps the search.'
            },
            {
              name: 'relatedSeason',
              in: 'query',
              schema: { type: 'string', maxLength: 120 },
              description:
                'Suggests around this season as well, or alone: its teams ' +
                'first, then its league\u2019s. The same rules as ' +
                '`relatedTeam`; an unknown season answers 404.'
            },
            {
              name: 'externalId',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: "Another service's ids for the team"
            },
            {
              name: 'season',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description:
                'Seasons whose teams to list. Leaving it out lists the ' +
                'teams this person belongs to.'
            },
            {
              name: 'kind',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['full', 'external', 'any'],
                default: 'full'
              },
              description:
                'Which teams of the seasons: their own, the placeholder teams ' +
                'their games were played against, or both. Needs `season` ' +
                'unless `full`.'
            }
          ],
          responses: {
            200: { description: 'The teams, which may be an empty list' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary:
            'Make a team, standalone or in a season, known by external ids',
          description:
            '**Who may call:** anybody signed in. The caller becomes the ' +
            'administrator of the team, and of a season the call makes, and, ' +
            'unless they are a site administrator, the team\u2019s owner, so ' +
            'it lists among their teams. ' +
            'Putting the team in an existing season takes an administrator ' +
            'of that season or its league, or a site administrator.\n\n' +
            '**The body:** `name` is trimmed and 1-100 characters. `season` ' +
            'is optional; without it the team is standalone, in no season. ' +
            'It is `{id}`, an existing season (404 when there is none, 403 ' +
            'when the caller does not administer it or its league), or ' +
            '`{name, year}`: the first season with that name in that year, ' +
            'ignoring case and outer spaces, that the caller administers, ' +
            'else a new one in no league. `name` is ' +
            '1-100 characters after trimming and `year` a whole year from ' +
            '1900 to 2200. `externalIds` is optional, at most 20 of ' +
            '`{system, id, kind}`, with `system` matching ' +
            '`^[a-z][a-zA-Z0-9]{0,31}$` and `id` and `kind` non-empty.\n\n' +
            '**What it does:** when any of the external ids (the same ' +
            'system, kind and id) already names a team the caller can see, ' +
            'nothing is made and the answer is 200 with that team (the one ' +
            'it was merged into, if it was) and `season: null`. The ' +
            'body\u2019s other ids nothing holds are recorded on it only when ' +
            'the caller administers it. An id on a ' +
            'team the caller cannot see, or on something other than a team, ' +
            'is 409, and nothing is made. Otherwise, in one transaction, a ' +
            'regular team is made, put in the season, and given the ids, and ' +
            'the answer is 201 with the season and whether this call made ' +
            'it, or `season: null` for a standalone team.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    season: {
                      nullable: true,
                      oneOf: [
                        {
                          type: 'object',
                          required: ['id'],
                          properties: { id: { type: 'string' } }
                        },
                        {
                          type: 'object',
                          required: ['name', 'year'],
                          properties: {
                            name: {
                              type: 'string',
                              minLength: 1,
                              maxLength: 100
                            },
                            year: {
                              type: 'integer',
                              minimum: 1900,
                              maximum: 2200
                            }
                          }
                        }
                      ]
                    },
                    externalIds: {
                      type: 'array',
                      maxItems: 20,
                      items: {
                        type: 'object',
                        required: ['system', 'id', 'kind'],
                        properties: {
                          system: {
                            type: 'string',
                            pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                          },
                          id: { type: 'string', minLength: 1 },
                          kind: { type: 'string', minLength: 1 }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                'An external id already named this team; nothing was made',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name', 'created', 'season'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      created: { type: 'boolean', enum: [false] },
                      season: { type: 'null' }
                    }
                  }
                }
              }
            },
            201: {
              description:
                'The team was made, in this season or, with `season: null`, ' +
                'standalone',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name', 'created', 'season'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      created: { type: 'boolean', enum: [true] },
                      season: {
                        type: 'object',
                        nullable: true,
                        required: ['id', 'name', 'year', 'created'],
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          year: { type: 'integer' },
                          created: { type: 'boolean' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/teams/{teamId}/games': {
        get: {
          summary: "A team's games, newest first",
          description:
            'Answers 404 rather than 403 for a team the caller may not see, ' +
            'so that probing cannot reveal which teams exist. Anybody signed ' +
            'in who is not a member of the team (the non-member view) reads ' +
            'its games too, with their video counts, posters and logos.',
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            {
              name: 'when',
              in: 'query',
              description:
                'Which of the games, as on `GET /events`. Defaults to `all`.',
              schema: {
                type: 'string',
                enum: [
                  'all',
                  'upcoming',
                  'past',
                  'future',
                  'finished',
                  'recent'
                ],
                default: 'all'
              }
            },
            {
              name: 'order',
              in: 'query',
              description:
                'Defaults to newest first, and to soonest first for `when=upcoming` or `when=future`.',
              schema: { type: 'string', enum: ['asc', 'desc'] }
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Page size. Only with `paged`.',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 50
              }
            },
            ...schedulePageParams
          ],
          responses: {
            200: {
              description:
                '`Page` of the same rows with `paged`. Games, newest first, with a video count. Authorized team views also include playerRsvps {yes,unknown,no}, counting active current team players only; unknown combines Maybe and No reply. Pending proposals and non-member views omit playerRsvps.'
            },
            404: errorResponse
          }
        },
        post: {
          summary: "Schedule a team's games",
          description:
            'Schedules up to 200 games for the team in one call, and answers ' +
            'each row on its own, in order. Rows are applied one at a time, ' +
            'each in its own transaction, so one refused row stops nothing.\n\n' +
            '**Who may call:** a signed-in human administrator of the team, ' +
            'directly or through a true management parent, or a node admin. A plain ' +
            'member or parent gets 403; a team the caller can ' +
            'neither see nor administer gets 404. A season or league admin ' +
            'must administer both proposed participating teams ' +
            'to publish a mutating row immediately; the hosting season is no additional consent side. Otherwise the row is ' +
            '`forbidden`: Additional approval is required; use game proposals. ' +
            'All identity, game, external-ID and audit changes for that row roll back. ' +
            'Until ownership setup is complete, mutating rows are refused; ' +
            'safe unchanged retries still succeed without publishing changes. ' +
            'This response contains only published game IDs, never hidden pending proposals. ' +
            'Machine tokens and supplied cached rights cannot bypass consent.\n\n' +
            '**A row:** `opponent` (`{teamId, externalId?}`, or ' +
            '`{name, externalId?}` with ' +
            'a name of 1-120 characters) and `side` (`home` or `away`, the ' +
            'side this team plays on) are needed to create a game. On a ' +
            'matched one, `opponent` may change the opponent and `side` may ' +
            'swap the sides (below). ' +
            '`startAt` is required, an ISO 8601 date-time with `Z` or an ' +
            'offset. On new rows an explicit `seasonId` may name an authorized ' +
            'host even for nonmembers and dates outside its reference range. ' +
            'Omission selects only an unambiguous eligible active season by ' +
            'the request calendar day, then year; overlaps require an explicit ID. ' +
            'A held legacy row retains its stored season. Use game proposals ' +
            'for outside games (explicit null) or host changes. ' +
            '`venue` (at most 200 characters) and `status` (`scheduled` ' +
            'or `cancelled`) are optional; omitted, a held game keeps its own. ' +
            '`fenceDistanceFt` (whole feet, 1 to 600) is optional too: ' +
            "omitted, a new game is played to its season's or league's " +
            'fence and a held game keeps its own, as does one with plays. ' +
            '`externalId` is optional `{system, id, kind?}`, with `system` and ' +
            '`kind` matching `^[a-z][a-zA-Z0-9]{0,31}$` and `kind` defaulting ' +
            'to `event`.\n\n' +
            '**What a row does:** with an `externalId`, a game already holding ' +
            'that system and id (of any kind) is matched. Its opponent may ' +
            'change, whatever its status (below); otherwise an `inProgress` ' +
            'or `final` game is left as it is, and a `scheduled` or ' +
            "`cancelled` one takes the row's time, venue, status and fence " +
            'distance, and ' +
            'is `updated` when any of them changed. When the row gives a ' +
            '`side` other than the one this team plays on, the other team is ' +
            'a placeholder and the game has no plays (none stored and no ' +
            'at-bat under way), its home and away teams swap, their scores ' +
            'with them, and the row is `updated`. A game with plays, or ' +
            'between two regular teams, keeps its sides, and the row is ' +
            'answered by its other fields. The season never changes, and a ' +
            'game matched by time rather than by id keeps its sides. ' +
            'Without a match, a game in the same season ' +
            'between the same two teams at the same time takes the id. ' +
            'Otherwise the row creates a game. A row without `externalId` ' +
            'always creates one. An opponent named by `name` is a team of the ' +
            'season with that name, else the oldest placeholder team of that ' +
            'name, else a new placeholder team with explicit host-season custody. ' +
            'An existing placeholder team retains its custodian and requires that ' +
            'custodian approval. A withdrawn game cannot be restored or revised. ' +
            'Unchanged retries do not require fresh counterpart consent; new ' +
            'aliases and identity corrections are audited mutations.\n\n' +
            '**Names:** a `name` finds a team only by the name itself: two ' +
            'names are the same when they are, once trimmed, with runs of ' +
            'spaces made one and case ignored. Any other difference (a ' +
            'trailing number, punctuation, a note in brackets) is another ' +
            'team. A client that knows two spellings are one team names it ' +
            'by `teamId`.\n\n' +
            "**An opponent's id:** `opponent.externalId` is `{system, kind, " +
            'id}`, `system` matching `^[a-z][a-zA-Z0-9]{0,31}$` and `kind` and ' +
            '`id` non-empty, the id another system has for the opponent. ' +
            'With `teamId`, that team is the opponent (an unknown one is ' +
            '`notFound`, this team itself and a merged team are `conflict`), ' +
            'and it takes the id when it is a placeholder team and nothing ' +
            "holds the id. On a matched game, the game's opponent takes it " +
            'the same way when `teamId` names that opponent, before anything ' +
            'else, so a game scored in TeamStation records it too. With ' +
            '`name`, a ' +
            'team already holding it (a placeholder or a regular team, followed ' +
            'through merges) is the opponent, whatever the name says, except ' +
            "a placeholder team whose name is not the row's and which is " +
            "named as a placeholder (below), is shared by other teams' " +
            'games, or would by that name be a second team of one name (the ' +
            '`name` already finds a team). For those the opponent is found ' +
            'by `name` ' +
            'alone. Otherwise the opponent is found by name, and a placeholder ' +
            'team found or made that way takes the id when nothing holds it ' +
            'and the `name` is not a placeholder. On a matched game, the ' +
            "game's opponent takes the id when it is a placeholder team, the " +
            "row's `name` finds it by that same rule, and nothing holds the " +
            'id. A regular team never takes an id here, and an id something ' +
            'already holds never moves, except one left on a team that no ' +
            'longer exists, which the team found takes over. Recording an ' +
            'opponent id alone leaves the row `unchanged`: the answer ' +
            'describes the game.\n\n' +
            "**A matched game's opponent:** only a placeholder opponent " +
            'changes; a game against a regular team keeps it. An undecided opponent ' +
            '`name`, saying the opponent is not known yet (one starting ' +
            '`TBD`, `TBA`, `To be decided`, `To be announced` or `To be ' +
            'determined`, in any case), leaves the opponent as it is, and ' +
            "takes no id. So does a `name` that is this team's own. A " +
            "`name` that is the opponent's changes nothing, whatever team " +
            "holds the row's id. Otherwise the row's opponent is found by " +
            'its id, as above, then by its `name`: a team of the season or ' +
            'a placeholder team of that name, else a new placeholder team. A ' +
            '`{teamId}` naming the opponent changes nothing; naming another ' +
            "team moves the game to it. When the row's id is held by the game's " +
            "opponent and stands for the row's `name` by the rule above, " +
            "that team is renamed to the row's `name`, in every game it " +
            'plays, and the row is `updated`; otherwise it keeps its name, ' +
            "and this game's opponent is found by the `name` alone. Any other " +
            "team found or made becomes the game's opponent, even after plays " +
            'and a final score, and the row is `updated`: the score, the ' +
            "sides and the plays stay; the plays' batting team, player rows " +
            'and credits, and a camera key filming that side, move to the ' +
            "new team; the game's stats are rebuilt. A team found by the " +
            "row's id takes the row's `name` too. The old team stays, with no " +
            'game if it has none left. A game scored in TeamStation (scored ' +
            'by its scorer, a play carrying its `teamStation` record, or an ' +
            'at-bat under way) keeps its opponent, and the row is answered by ' +
            'its other fields; `GET /events` marks such a game, and one ' +
            'between two regular teams, `opponentFixed`. A move onto a regular ' +
            'team already playing this team in the same season at the ' +
            "game's time or the row's is a `conflict`: `<team> already has " +
            'this game`.\n\n' +
            '**Answers:** `result` is `created`, `updated`, `unchanged` or ' +
            "`error`, with `gameId` and the game's `status` after the row. " +
            'Error codes: `invalid`, `notFound`, `conflict`, `noSeason`, ' +
            '`forbidden`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['games'],
                  properties: {
                    games: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['startAt'],
                        properties: {
                          exhibition: {
                            type: 'boolean',
                            default: false,
                            description:
                              'Game classification independent of placeholder identity. Omitted updates retain the stored value.'
                          },
                          timezone: {
                            type: 'string',
                            description:
                              'Valid IANA timezone, retained on update when omitted; defaults to the hosting season timezone or UTC on creation.'
                          },
                          opponent: {
                            oneOf: [
                              {
                                type: 'object',
                                required: ['teamId'],
                                properties: {
                                  teamId: { type: 'string' },
                                  externalId: {
                                    type: 'object',
                                    required: ['system', 'kind', 'id'],
                                    properties: {
                                      system: {
                                        type: 'string',
                                        pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                                      },
                                      kind: { type: 'string', minLength: 1 },
                                      id: { type: 'string', minLength: 1 }
                                    }
                                  }
                                }
                              },
                              {
                                type: 'object',
                                required: ['name'],
                                properties: {
                                  name: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: 120
                                  },
                                  externalId: {
                                    type: 'object',
                                    required: ['system', 'kind', 'id'],
                                    properties: {
                                      system: {
                                        type: 'string',
                                        pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                                      },
                                      kind: { type: 'string', minLength: 1 },
                                      id: { type: 'string', minLength: 1 }
                                    }
                                  }
                                }
                              }
                            ]
                          },
                          side: { type: 'string', enum: ['home', 'away'] },
                          startAt: { type: 'string', format: 'date-time' },
                          seasonId: { type: 'string' },
                          venue: {
                            type: 'string',
                            nullable: true,
                            maxLength: 200
                          },
                          status: {
                            type: 'string',
                            enum: ['scheduled', 'cancelled']
                          },
                          fenceDistanceFt: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 600
                          },
                          externalId: {
                            type: 'object',
                            required: ['system', 'id'],
                            properties: {
                              system: {
                                type: 'string',
                                pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                              },
                              id: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 200
                              },
                              kind: {
                                type: 'string',
                                pattern: '^[a-z][a-zA-Z0-9]{0,31}$',
                                default: 'event'
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
          },
          responses: {
            200: {
              description:
                'One answer per row, in order, and the counts, even when ' +
                'every row failed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['index', 'result'],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'updated', 'unchanged', 'error']
                            },
                            gameId: { type: 'string' },
                            status: {
                              type: 'string',
                              enum: [
                                'scheduled',
                                'inProgress',
                                'final',
                                'cancelled'
                              ]
                            },
                            error: {
                              type: 'object',
                              required: ['code', 'message'],
                              properties: {
                                code: {
                                  type: 'string',
                                  enum: [
                                    'invalid',
                                    'notFound',
                                    'conflict',
                                    'noSeason',
                                    'forbidden'
                                  ]
                                },
                                message: { type: 'string' }
                              }
                            }
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          updated: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players': {
        post: {
          summary: "Add a team's players by external id",
          description:
            'Adds 1 to 200 players in one call, in one transaction, and ' +
            'answers each row in order. Each row is a person another system ' +
            'knows by `externalId`.\n\n' +
            '**Who may call:** an administrator of the team (set on the ' +
            'team, its season or its league, or its owner or manager) or a ' +
            'site administrator. Anyone else gets 403; a team the caller ' +
            'cannot see gets 404. A person an external id already names is ' +
            'added to the team wherever else they are.\n\n' +
            '**A row:** `firstName` and `lastName` (trimmed, at most 100 ' +
            'characters, either may be empty), `jersey` (at most 3 ' +
            'characters), `bats` (`left`, `right` or `switch`), `throws` ' +
            '(`left` or `right`) and `externalId` `{system, kind, id}`, with ' +
            '`system` matching `^[a-z][a-zA-Z0-9]{0,31}$`. One malformed row ' +
            'refuses the call with a 400 naming it.\n\n' +
            '**What a row does:** the user holding the external id (merged ' +
            'accounts followed to the one they became) is the player; ' +
            'otherwise a new user is made, who cannot sign in, named `first ' +
            'last` or `Unknown player`, with the id recorded on them. That ' +
            "user's membership of the team is made a player's: a new one is " +
            'a `member` with the jersey, and an existing one keeps its jersey ' +
            'unless it had none. Each of `bats` and `throws` sent replaces ' +
            'an imported one and is never written over a coach\u2019s; a ' +
            'hand not sent is left as it is. An id held by something that ' +
            "is not a user is that row's `conflict`; the other rows still " +
            'apply.\n\n' +
            '**Answers:** `result` is `created` (a new user), `joined` (an ' +
            'existing user newly a player here), `unchanged` (already a ' +
            'player here) or `error`, with the `userId`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['players'],
                  properties: {
                    players: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['externalId'],
                        properties: {
                          ...personNames,
                          jersey: { type: 'string', maxLength: 3 },
                          bats: {
                            type: 'string',
                            enum: ['left', 'right', 'switch']
                          },
                          throws: { type: 'string', enum: ['left', 'right'] },
                          externalId: memberExternalId
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'One answer per row, in order, and the counts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['index', 'result'],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'joined', 'unchanged', 'error']
                            },
                            userId: userIdSchema,
                            error: memberRowError
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          joined: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/adults': {
        post: {
          summary: "Add a team's parents, followers and staff by external id",
          description:
            'Adds 1 to 200 adults in one call, in one transaction, and ' +
            'answers each row in order. Nobody is mailed, and nothing is ' +
            'ever taken away. Add the players first, so guardian links find ' +
            'them.\n\n' +
            '**Who may call:** an administrator of the team (set on the ' +
            'team, its season or its league, or its owner or manager) or a ' +
            'site administrator. Anyone else gets 403; a team the caller ' +
            'cannot see gets 404.\n\n' +
            '**A row:** `firstName` and `lastName` (trimmed, at most 100 ' +
            'characters, either may be empty), `email` (optional; trimmed, ' +
            'lower-cased, with an `@`), `externalId` `{system, kind, id}`, ' +
            "`guardianOf` (the players' external ids, possibly none) and " +
            '`staff` (true or false). One malformed row refuses the call with ' +
            'a 400 naming it.\n\n' +
            '**Who a row is:** the user holding the external id (merged ' +
            'accounts followed); otherwise the user holding the address, ' +
            'who then gets the external id only when the caller is a site ' +
            'administrator (otherwise the row says `externalIdNotAttached`); ' +
            'otherwise a new user, named ' +
            '`first last` or `Unknown adult`, who may sign in by e-mail code ' +
            "when there is an address. An existing user's sign-in setting is " +
            'never changed.\n\n' +
            '**The address:** already theirs, nothing changes. Held by ' +
            'nobody, it is attached, as their primary address, to an account ' +
            'this call made; to an account already here only when the ' +
            'caller is a site administrator and the account has no address ' +
            'at all. Otherwise it is left off and the row says ' +
            '`emailNotAttached`. Held by somebody else, it stays there and ' +
            'the row says `emailHeldElsewhere`.\n\n' +
            '**What a row gains:** a membership of the team as a `member` ' +
            'when they have none (an existing membership is left as it is, ' +
            'and its role is never raised); a guardian link, which ' +
            'may manage, to each `guardianOf` player of this team (an id ' +
            'naming no player here is counted in `guardiansMissing`); and, ' +
            'for staff, the `coach` and `scorekeeper` roles on the team. ' +
            'Roles are only ever added, and `admin` never is.\n\n' +
            '**Guardian links are refused** (counted in `guardiansRefused`) ' +
            'to a player who had a guardian who can sign in before this ' +
            "call began, since that player's guardians decide who else " +
            'becomes one (a parent imported with no email cannot sign in, ' +
            'so takes no say), and for ' +
            "the caller's own account; every parent one call names for a " +
            'player with no guardian is linked. A site administrator is held ' +
            'to neither. An adult who already guards the player is neither ' +
            'linked again nor refused.\n\n' +
            '**Answers:** `result` is `created` (a new user), `matched` (an ' +
            'existing user who gained something here), `unchanged` or ' +
            '`error`. `counts.guardianLinks` is the links this call made, ' +
            '`counts.guardiansRefused` the links it refused, and ' +
            '`counts.staff` the adults who gained a role in it; posting the ' +
            'same body again answers both as 0.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['adults'],
                  properties: {
                    adults: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 200,
                      items: {
                        type: 'object',
                        required: ['externalId'],
                        properties: {
                          ...personNames,
                          email: { type: 'string', maxLength: 254 },
                          externalId: memberExternalId,
                          guardianOf: {
                            type: 'array',
                            maxItems: 50,
                            items: memberExternalId
                          },
                          staff: { type: 'boolean', default: false }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'One answer per row, in order, and the counts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['results', 'counts'],
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: [
                            'index',
                            'result',
                            'joined',
                            'guardianLinks',
                            'guardiansMissing',
                            'guardiansRefused',
                            'rolesAdded'
                          ],
                          properties: {
                            index: { type: 'integer' },
                            result: {
                              type: 'string',
                              enum: ['created', 'matched', 'unchanged', 'error']
                            },
                            userId: userIdSchema,
                            joined: { type: 'boolean' },
                            guardianLinks: { type: 'integer' },
                            guardiansMissing: { type: 'integer' },
                            guardiansRefused: { type: 'integer' },
                            rolesAdded: {
                              type: 'array',
                              items: {
                                type: 'string',
                                enum: ['coach', 'scorekeeper']
                              }
                            },
                            emailHeldElsewhere: {
                              type: 'boolean',
                              enum: [true]
                            },
                            emailNotAttached: {
                              type: 'boolean',
                              enum: [true]
                            },
                            externalIdNotAttached: {
                              type: 'boolean',
                              enum: [true]
                            },
                            error: memberRowError
                          }
                        }
                      },
                      counts: {
                        type: 'object',
                        properties: {
                          created: { type: 'integer' },
                          matched: { type: 'integer' },
                          unchanged: { type: 'integer' },
                          error: { type: 'integer' },
                          guardianLinks: { type: 'integer' },
                          guardiansRefused: { type: 'integer' },
                          staff: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/logo': {
        put: {
          summary: "Store a team's logo",
          description:
            'Stores the team\u2019s logo, padded to a square so a wide ' +
            'badge keeps its shape and a transparent one stays transparent.' +
            '\n\n' +
            pictureRules,
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          requestBody: pictureBody,
          responses: {
            200: pictureAnswer,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            413: errorResponse,
            415: errorResponse,
            503: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/avatar': {
        put: {
          summary: "Store a player's headshot",
          description:
            'Stores the headshot of a player of this team, cropped to a ' +
            'square. It is the person\u2019s own picture, so it shows on ' +
            'every team they are on. A user who is not a player of this ' +
            'team is 404. A headshot whose source is `upload` is replaced ' +
            'only by a site administrator\u2019s upload; anybody else\u2019s ' +
            'answers `stored: false, kept: upload`.\n\n' +
            pictureRules,
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: pictureBody,
          responses: {
            200: pictureAnswer,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            413: errorResponse,
            415: errorResponse,
            503: errorResponse
          }
        }
      },
      '/games/{gameId}': {
        get: {
          summary: 'One game and its videos',
          description:
            '`fenceDistanceFt` is the fence the game is played to, in feet: ' +
            "the game's own, else its season's, else that season's " +
            "league's, else 200. A game with plays keeps the fence it had " +
            'when they began. `canScore` is whether the caller may post its ' +
            'plays: a scorekeeper of either team, which every admin of it ' +
            'is. `canDj` is whether the caller may DJ it: a songkeeper or ' +
            'scorekeeper of either team, which every admin of it is. ' +
            '`coachSides` is the sides whose team the caller head-coaches ' +
            '(the coach flag, which every admin of the team holds; not an ' +
            'assistant), and so whose lineup they may save. ' +
            '`assignedRoles` lists the caller’s roles by `away` and `home`, ' +
            'including season/league inheritance but excluding implied privileges. ' +
            'It filters hero actions only; authorization flags remain unchanged. ' +
            '`scoreboard` is `{ open, mayOverride }`: ' +
            "whether the game's scoreboard is open, and whether the caller " +
            'runs the game and so may override it; null when the ' +
            'scoreboard store cannot be asked. `nonMemberView` is true for ' +
            'anonymous callers and signed-in callers who are members of neither team: ' +
            'that caller reads the game, its records, logos and videos with ' +
            'their posters, but each `linescore` side carries `runs` and `r` ' +
            'alone (`h`, `e`, `bb`, `k`, `hr` and `hbp` are null), and ' +
            '`canScore` and `canDj` are false and `coachSides` empty. ' +
            'Private notes, arrival timing, ingest details, scoring ownership and ' +
            'scoreboard access are null in this public projection. Playback ' +
            'and detailed statistics still require team membership. ' +
            'False for members. ' +
            '`replayable` is whether anything TeamStation scored is stored ' +
            'for the game — a play carrying its `teamStation` record, or a ' +
            'recorded at-bat in progress — so it can be replayed. ' +
            '`umpires` is null when league umpire management is off or no positions are required; otherwise it contains positions with stable slot, typeId, typeName, ordinal, required and person (a { userId, name, avatarUrl } or null). Names are abbreviated.',
          security: [{}, { bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: { description: 'The game, its score and its videos' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/narrations/{stepKey}': {
        get: {
          summary: "The replay's announcer reading one step of a game",
          description:
            "A step of the game's replay is one delivery, a pitch or a ball " +
            'put in play, with what the scorer took after it up to the next; ' +
            'its key is `<atBatIndex>-<actionStart>`, the play and the index ' +
            "of the step's first action in that play's `teamStation` " +
            "record. The server writes the step's sentence from the game's " +
            'stored plays, naming players by first name and the start of ' +
            'the last, and answers it spoken as MP3. A step grows as the ' +
            'scorer goes on; `count` asks for it as it stood with its first ' +
            '`count` actions, the sentence a viewer who saw it then was ' +
            'shown. A sentence is spoken ' +
            'once and kept; `ETag` is its digest, and a matching ' +
            '`If-None-Match` answers 304. **Who may call:** anybody who may ' +
            "read the game's events.",
          security: [{ bearer: [] }],
          parameters: [
            gameIdParam,
            {
              name: 'stepKey',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^[0-9]+-[0-9]+$' }
            },
            {
              name: 'count',
              in: 'query',
              required: false,
              description:
                "How many of the step's actions the sentence is for. All " +
                'of them when absent or larger than the step.',
              schema: { type: 'integer', minimum: 1 }
            }
          ],
          responses: {
            200: {
              description: 'The sentence, spoken',
              content: {
                'audio/mpeg': { schema: { type: 'string', format: 'binary' } }
              }
            },
            304: { description: 'The sentence the caller already has' },
            400: errorResponse,
            404: errorResponse,
            503: {
              description: 'Speech is off, or the speech service failed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'string', enum: ['narrationUnavailable'] }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/games/{gameId}/field': {
        put: {
          summary: "Set or clear one game's fence distance",
          description:
            'Whole feet, 1 to 600, from home plate to the fence, which ' +
            "sizes the ball's `totalDistance` and `coordinates` on the " +
            "game's plays. `null` clears the game's own, so its season's, " +
            "its league's or 200 feet applies. The fence is fixed once the " +
            'game has plays, whatever its status: the post that stores its ' +
            "first keeps the fence they were sized by (the post's " +
            '`fenceDistanceFt`, else the one the game resolves to then), ' +
            'whatever its season or league later sets, and this answers 409 ' +
            'while the game has plays. **Who may call:** ' +
            'a site admin, an admin of either team (an admin `scope_roles` ' +
            "team row, or its owner or manager), or an admin of the game's season " +
            'or its league. Anybody else who can see the game gets 403; a ' +
            'game the caller cannot see, or that does not exist, 404.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: fenceDistanceBody
              }
            }
          },
          responses: {
            200: {
              description:
                'What the game holds now, and the fence it is played to',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'gameId',
                      'fenceDistanceFt',
                      'resolvedFenceDistanceFt'
                    ],
                    properties: {
                      gameId: { type: 'string' },
                      fenceDistanceFt,
                      resolvedFenceDistanceFt: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 600
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/tags': {
        get: {
          summary: 'Read your ten recent distinct tags and global popularity',
          parameters: [
            {
              name: 'includeUnused',
              in: 'query',
              required: false,
              schema: { type: 'boolean', default: false },
              description:
                'Include the retained global catalog with zero-count labels; otherwise return up to thirty actively used popular tags'
            }
          ],
          security: [{ bearer: [] }],
          responses: {
            '200': {
              description:
                'Recent labels and popular labels with active assignment counts'
            },
            '401': { description: 'Authentication required' },
            '400': { description: 'Invalid includeUnused parameter' }
          }
        }
      },
      '/games/{gameId}/tags/{targetId}': {
        put: {
          summary: 'Assign or replace one scoring event tag',
          description:
            'Locks the game; repeated identical saves are idempotent. Tags normalize casing and whitespace and contain 1–64 Unicode code points. Scorekeepers of either team may edit; user history belongs to the authenticated actor.',
          security: [{ bearer: [] }],
          parameters: [
            gameIdParam,
            {
              name: 'targetId',
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
                  type: 'object',
                  required: ['tag'],
                  properties: { tag: { type: 'string', maxLength: 128 } }
                }
              }
            }
          },
          responses: {
            '200': {
              description:
                'Target identity, normalized label and committed-write revision',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['targetId', 'tag', 'revision'],
                    properties: {
                      targetId: { type: 'string' },
                      tag: { type: 'string' },
                      revision: {
                        type: 'string',
                        pattern: '^[0-9]+$',
                        description:
                          'Monotonic decimal write revision issued under the game lock; compare numerically without loss of precision.'
                      }
                    }
                  }
                }
              }
            },
            '400': { description: 'Invalid tag' },
            '401': { description: 'Authentication required' },
            '403': { description: 'Scoring permission required' },
            '404': { description: 'Game or target not found' }
          }
        },
        delete: {
          summary: 'Remove one scoring event tag, retaining account history',
          security: [{ bearer: [] }],
          parameters: [
            gameIdParam,
            {
              name: 'targetId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            '200': {
              description:
                'Target identity, null tag and committed-write revision',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['targetId', 'tag', 'revision'],
                    properties: {
                      targetId: { type: 'string' },
                      tag: { type: 'null' },
                      revision: {
                        type: 'string',
                        pattern: '^[0-9]+$',
                        description:
                          'Monotonic decimal write revision, including removal.'
                      }
                    }
                  }
                }
              }
            },
            '401': { description: 'Authentication required' },
            '403': { description: 'Scoring permission required' },
            '404': { description: 'Game or target not found' }
          }
        }
      },
      '/games/{gameId}/events': {
        patch: {
          summary:
            "Add every event, with its time, to a game's stored plays (a partial update: a play not named keeps its events)",
          description:
            "For a node administrator. Puts each named play's `playEvents` " +
            '(each pitch, ball in play, base-running and line-up event, each ' +
            "with its `startTime`) on the play an outside scorer's import " +
            "stored at that `atBatIndex`, a final game's included. Nothing " +
            'else is written: the plays, their times, scores, people, runners ' +
            "and credits and the game's status stay as stored, and a play not " +
            'named keeps its events. No statistics rebuild is asked for: the ' +
            'stored statistics stand until the next one, which then counts ' +
            'pitches, called third strikes, wild pitches and balks from the ' +
            'events; event tags follow the events the next time the plays are ' +
            "read. Each event's " +
            '`description` is not stored. The whole body is refused for a game ' +
            'TeamStation scores (409), and for a play the game does not have, ' +
            'a play named twice, or an event that is not a GUMBO play event or ' +
            'has no `startTime` (400).',
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
                  type: 'object',
                  required: ['plays'],
                  properties: {
                    plays: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['atBatIndex', 'playEvents'],
                        properties: {
                          atBatIndex: { type: 'integer' },
                          playEvents: {
                            type: 'array',
                            items: { type: 'object' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'How many plays and events were written',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['plays', 'events'],
                    properties: {
                      plays: { type: 'integer' },
                      events: { type: 'integer' }
                    }
                  }
                }
              }
            },
            '400': {
              description:
                'A play the game lacks, or an event that is not timed or not GUMBO'
            },
            '401': { description: 'Authentication required' },
            '403': { description: 'Node administrator required' },
            '404': { description: 'Game not found' },
            '409': { description: 'The game is scored in TeamStation' }
          }
        },
        post: {
          summary: "Replace a game's plays",
          description:
            'One body is the whole set. A play is replaced when its ' +
            '`about.atBatIndex` is already stored, and a stored index that is ' +
            'not in the body is deleted, including a legacy line-score-only ' +
            '`final_score` play, at index 9999 or, in a game with no other ' +
            'plays, at index 0. `source.system` names the sender: ' +
            '`teamstation`, `manual`, or an outside system spelled as an ' +
            "external id's system is, and a post with no `source` or no " +
            '`source.system` counts as an outside one. `teamstation` sets ' +
            '`scoringOwner`. An outside post is stored as `external`, is ' +
            'rejected once that owner is set, and its ' +
            "plays' `result.description` and `playEvents[].description` are " +
            "not stored. A post whose plays carry both teams' scores sets " +
            'the game `final`, and a final game refuses every later post with ' +
            '409, so a game is posted once it is over. Otherwise a ' +
            'game becomes `inProgress` only with a surviving pitch or ball ' +
            'in play; otherwise it is `scheduled`. Cancelled games stay cancelled. ' +
            "The post that stores a game's first plays, whatever its status, " +
            'fixes its fence at the `fenceDistanceFt` it gives, else the one ' +
            'the game resolves to then, so a later season or league change ' +
            'never resizes its plays. ' +
            'The stats builder counts batting and pitching lines from these ' +
            'plays. Every counted play needs `about.inning`, ' +
            '`about.halfInning`, `matchup.pitcher`, `count.outs` and ' +
            '`runners[]`. A plate appearance also needs `matchup.batter` and ' +
            "the batter's own runner entry (`movement.start` null, " +
            '`details.runner` naming the batter). Every runner entry with a ' +
            '`movement` needs `details.runner`, `details.eventType`, and ' +
            '`movement.end` (or null when `movement.isOut` is true). A ' +
            'scoring entry also needs `details.responsiblePitcher`, ' +
            '`details.earned` and `details.rbi`. A player object may omit ' +
            '`id` (an unmapped opponent); a present `id` must name a ' +
            'TeamStation user. When the last play carries ' +
            '`result.awayScore` and `result.homeScore`, the runs from ' +
            "the 'score' runner entries must equal that score. A play that " +
            'lacks a required field is still stored: the builder marks the ' +
            'game `incomplete` with the reason and leaves any earlier ' +
            '`game_player_stats` rows untouched. **Who may call:** a ' +
            'scorekeeper of either team, set on the team, its season or its ' +
            'league, which every admin of them is, and a site admin. Anybody ' +
            'else who can see the game gets 403. Tagged activity edits that ' +
            'cannot be disambiguated without structured event identities return ' +
            '409 without changing the stored events or assignments. A live ' +
            'post naming a `lineupsBase` that is no longer the game’s lineups ' +
            'digest, because somebody else saved the lineups since the sender ' +
            'read them, is refused with 409 and `details: { stale: true }`, ' +
            'and writes nothing: the sender reads the game again and posts ' +
            'its changes on top of it. A live post naming a `generation` ' +
            'other than the game’s, made before a reset deleted its plays, ' +
            'is refused the same way with `details: { stale: true, ' +
            'generation }`: the sender opens the game again.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['plays'],
                  properties: {
                    plays: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/GumboPlay' }
                    },
                    source: {
                      type: 'object',
                      properties: {
                        system: {
                          type: 'string',
                          pattern: '^[a-z][a-zA-Z0-9]{0,31}$'
                        }
                      }
                    },
                    mode: {
                      type: 'string',
                      enum: ['replace', 'live'],
                      description:
                        '`replace`, the default, is a finished game arriving ' +
                        'whole. `live` is a game being scored: the plays sent ' +
                        'are written in place and only the indexes in ' +
                        '`remove` are deleted.'
                    },
                    remove: {
                      type: 'array',
                      items: { type: 'integer' },
                      description: 'On a live post: the indexes to delete'
                    },
                    currentPlay: {
                      oneOf: [
                        { $ref: '#/components/schemas/GumboCurrentPlay' },
                        { type: 'null' }
                      ],
                      description:
                        'On a live post: the at-bat in progress, or null ' +
                        'when there is none. Left out, the stored one stays.'
                    },
                    fenceDistanceFt: {
                      type: 'integer',
                      description:
                        "Feet to the fence the plays' distances were sized " +
                        "by: the game's `gameData.venue.fieldInfo.center`, " +
                        'which the plays do not carry. The post that stores ' +
                        "a game's first plays fixes its fence at this one. " +
                        'Anything but whole feet from 1 to 600 is ignored, ' +
                        "and the game's resolved fence is fixed instead."
                    },
                    lineupsBase: {
                      type: 'string',
                      description:
                        'On a live post: the `lineupsDigest` the sender last ' +
                        'read or was answered with. Left out, the post is ' +
                        'not checked against the lineups.'
                    },
                    generation: {
                      type: 'integer',
                      description:
                        'On a live post: the play generation the sender ' +
                        'opened the game on. Once the game has been reset ' +
                        'since, the post is refused with 409 and `details: ' +
                        '{ stale: true, generation }`. Left out, the post is ' +
                        'not checked against it.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The stored plays, in atBatIndex order',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'plays',
                      'currentPlay',
                      'playsDigest',
                      'lineupsDigest'
                    ],
                    properties: {
                      plays: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['id', 'gameId', 'gumbo'],
                          properties: {
                            id: { type: 'string' },
                            gameId: { type: 'string' },
                            gumbo: { $ref: '#/components/schemas/GumboPlay' }
                          }
                        }
                      },
                      currentPlay: {
                        oneOf: [
                          { $ref: '#/components/schemas/GumboCurrentPlay' },
                          { type: 'null' }
                        ]
                      },
                      playsDigest: {
                        type: 'string',
                        description:
                          'A digest of the stored plays and the at-bat in ' +
                          'progress once this post is written, as `GET` and ' +
                          "the game socket's `plays` notices give it."
                      },
                      priorPlaysDigest: {
                        type: ['string', 'null'],
                        description:
                          'On a live post, the same digest of the game as ' +
                          'the post found it, before writing: when it is the ' +
                          'one the sender last had, everything stored is its ' +
                          'own, and the notice carrying `playsDigest` is its ' +
                          'own echo. Null on a replace post.'
                      },
                      lineupsDigest: {
                        type: ['string', 'null'],
                        description:
                          "The digest the game keeps of both sides' lineups " +
                          'once this post is written, as `GET ' +
                          '/games/{gameId}/lineups` gives it: the ' +
                          '`lineupsBase` of the next live post. Null only ' +
                          'after a replace post to a game never scored live.'
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        },
        get: {
          summary: "A game's plays",
          description: 'The stored plays in `atBatIndex` order.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                '{ plays: [{ id, gameId, gumbo }], currentPlay, ' +
                'playsDigest, lineupsDigest }: `gumbo` is a `GumboPlay`, ' +
                '`currentPlay` a `GumboCurrentPlay` or null, `playsDigest` a ' +
                'digest of both, as a live post answers it and the game ' +
                "socket's `plays` notices carry it, and `lineupsDigest` the " +
                "digest the game keeps of both sides' lineups, which a live " +
                'post names as its `lineupsBase`, `generation` the ' +
                'game’s play generation, one more after each reset, and ' +
                '`swap` what swapping home and away does: `swap` before the ' +
                'first pitch, `reset` once TeamStation scored a play, and ' +
                '`scoredElsewhere` for a game it cannot swap, and `withdrawn` ' +
                'for a game a team withdrew from, which is never swapped',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'plays',
                      'currentPlay',
                      'playsDigest',
                      'lineupsDigest'
                    ],
                    properties: {
                      plays: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['id', 'gameId', 'gumbo'],
                          properties: {
                            id: { type: 'string' },
                            gameId: { type: 'string' },
                            gumbo: { $ref: '#/components/schemas/GumboPlay' }
                          }
                        }
                      },
                      currentPlay: {
                        oneOf: [
                          { $ref: '#/components/schemas/GumboCurrentPlay' },
                          { type: 'null' }
                        ]
                      },
                      playsDigest: { type: 'string' },
                      lineupsDigest: { type: 'string' },
                      generation: { type: 'integer' },
                      swap: {
                        type: 'string',
                        enum: ['swap', 'reset', 'scoredElsewhere', 'withdrawn']
                      }
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
      '/teams/{teamId}/default-lineup': {
        get: {
          summary: "A team's default lineup",
          description:
            'The starting lineup of the last game scored in TeamStation that ' +
            'began with a different one, the game it came from and when it ' +
            'was taken. The first live post after which a game has begun ' +
            "takes each side's starting lineup as its team's default, unless " +
            'the default already has the same order and fielders; undone ' +
            'back to before its first pitch, the game takes the lineup it ' +
            'begins with next. Substitutions, replace posts and outside ' +
            'posts never change it. The scoring screen starts a new game ' +
            'from it. The default keeps ids: each player with one is named ' +
            "by his account's short name among the team's roster as it reads " +
            'now. Needs somebody who can see the team; 404 for anybody else.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: {
              description: 'The default, or all three null',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DefaultLineup' }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/unroster': {
        put: {
          summary: 'Change one roster player’s availability for this game',
          description:
            'Only the head coach of the selected side may toggle a team player. Off removes the player from lineup and defense options and current placements; on restores the option without placing the player. Guests cannot be toggled. The exclusion and lineup changes commit together, and a play awaiting its result refuses the change. Repeating the current value is idempotent.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['side', 'userId', 'rostered'],
                  properties: {
                    side: { type: 'string', enum: ['away', 'home'] },
                    userId: userIdSchema,
                    rostered: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The game’s unrostered lists',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['away', 'home'],
                    properties: {
                      away: {
                        type: 'array',
                        uniqueItems: true,
                        items: { type: 'integer' }
                      },
                      home: {
                        type: 'array',
                        uniqueItems: true,
                        items: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/games/{gameId}/guest-players': {
        post: {
          summary: 'Create a persistent player for one game',
          description:
            'A roster manager for the selected side or a scorekeeper of either ' +
            'game team creates a guest with no ' +
            'login, email or team membership. The returned identity is appended ' +
            'to that side of GameDetail.guests before the client adds the player ' +
            'to its lineup. GameDetail.guestPlayers returns the saved guest details on reopen. Final, cancelled or unresolved plays refuse creation. ' +
            'With `{ side, userId, jersey?, positions?, teamId? }` instead, an existing player ' +
            '(one `GET /users?forTeam=` lists) joins this side for this game only, as a pool ' +
            'player: 201 with their entry and `notice.requestId` when their side was told, or ' +
            '202 `{ pending: { requestId } }` when their side must accept first. Any other key ' +
            'beside `userId` is 400; a player already on either team or a guest of either side is 409.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'side',
                    'firstName',
                    'lastName',
                    'jersey',
                    'positions',
                    'bats',
                    'throws'
                  ],
                  properties: {
                    side: { type: 'string', enum: ['away', 'home'] },
                    teamId: {
                      type: 'string',
                      description:
                        'The team the caller means; 409 when the side holds another, as after a swap of home and away'
                    },
                    firstName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    },
                    lastName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    },
                    jersey: {
                      type: 'string',
                      nullable: true,
                      maxLength: JERSEY_MAX_LENGTH
                    },
                    positions: {
                      type: 'array',
                      items: { type: 'string', enum: [...PLAYER_POSITIONS] }
                    },
                    bats: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right', 'switch']
                    },
                    throws: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right']
                    }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'The saved guest',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RosterEntry' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/games/{gameId}/guest-players/{userId}': {
        put: {
          summary: "Correct a game-only player's name",
          description:
            "Renames the guest's account (first, last and display name), so " +
            'every read of every game names him anew; no stored play ' +
            'changes, and nothing else does: a lineup save never renames a ' +
            "guest. The caller may save the lineup of the guest's side (that " +
            "team's head coach, or a scorekeeper of either team); anybody " +
            'else, and a guest whose account can sign in, get 403. Somebody ' +
            'who is no guest of this game, a merged account and a deleted ' +
            'one get 404. Save Rosters sends it for each game-only player ' +
            'whose name the roster editor corrected, before saving the ' +
            'lineup; offline it waits in the outbox ahead of that save.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['firstName', 'lastName'],
                  description: 'At least one part is not empty.',
                  properties: {
                    firstName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    },
                    lastName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The guest, named anew',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RosterEntry' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/lineups': {
        get: {
          summary: "Both sides' lineups in a game",
          description:
            'Read from the stored plays and the at-bat in progress: the ' +
            'lineup each side began with, every substitution the stored ' +
            'Gumbo announces, in game order, and the lineup as it stands, ' +
            'with the `digest` the game keeps of them. A game TeamStation ' +
            'did not score has only the substitutions its plays carry. ' +
            'Needs somebody who can see the game; 404 for anybody else.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: '{ away, home, digest }',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GameLineups' }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary: "Save one side's lineup in a game",
          description:
            "One side's players, batting order and defence, as its head " +
            'coach sets them between plays. The players are named by who ' +
            'they are: `gumboId`, including persisted game guests. ' +
            'Every other number is an ' +
            'index into `players`. The game is replayed as the scoring ' +
            'screen replays it, the lineup is applied as a scorer’s roster ' +
            'change, followed by a pinch runner who keeps the batting order ' +
            'for each of `runners`, and what that changes is saved as a ' +
            'scorer’s live post is. The other side cannot change. A save ' +
            'with nothing to change writes nothing. A save before the game ' +
            'begins leaves a scheduled game scheduled. A game with no record ' +
            'yet opens as the caller’s own scoring screen would open it: ' +
            "each team's default lineup arranges its side only when the " +
            'caller may see that team, and its roster order does otherwise. ' +
            'The answer’s `digest` is the one this save left, read as it was ' +
            'written, or the one it found when it changed nothing. `base` is the ' +
            '`digest` the caller last read; it is not compared, and the ' +
            'last save wins. **Who may call:** a head coach of the side’s ' +
            'team (the coach flag, or an admin of the team; not an ' +
            'assistant) or a scorekeeper of either team, and a site admin. ' +
            'Anybody else who can see the game gets 403; a game the caller ' +
            'cannot see, 404. A change the game cannot take now (a play to ' +
            'finish first, a game over) is 409 with its reason, and one it ' +
            'cannot take at all, or an index past `players`, 400. A game ' +
            'that keeps changing while the save replays it answers 409 ' +
            'after three tries, with `details: { retry: true }`: the same ' +
            'save sent again can go.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'side',
                    'base',
                    'players',
                    'battingOrder',
                    'defense'
                  ],
                  properties: {
                    side: { type: 'string', enum: ['away', 'home'] },
                    base: {
                      type: 'string',
                      description: 'The lineups `digest` the caller last read'
                    },
                    players: {
                      type: 'array',
                      description: "Every player on the side's roster",
                      items: {
                        type: 'object',
                        required: ['gumboId', 'fullName', 'jersey'],
                        properties: {
                          gumboId: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 9007199254740991
                          },
                          fullName: { type: 'string' },
                          jersey: { type: 'string' }
                        }
                      }
                    },
                    battingOrder: {
                      type: 'array',
                      items: { type: 'integer', minimum: 0 },
                      description: 'Indexes into `players`, leadoff first'
                    },
                    defense: {
                      type: 'object',
                      description:
                        'Each position held, P, C, 1B, 2B, SS, 3B, LF, CF ' +
                        'or RF, and the index into `players` of who plays it',
                      additionalProperties: { type: 'integer', minimum: 0 }
                    },
                    nextBatter: {
                      type: 'integer',
                      minimum: 0,
                      description:
                        'Who bats next, when it is not the batter due: a ' +
                        'pinch hitter'
                    },
                    runners: {
                      type: 'array',
                      description:
                        'Pinch runners who keep the batting order, each on ' +
                        'the base of the runner he runs for',
                      items: {
                        type: 'object',
                        required: ['base', 'player'],
                        properties: {
                          base: { type: 'string', enum: ['1B', '2B', '3B'] },
                          player: { type: 'integer', minimum: 0 }
                        }
                      }
                    },
                    generation: {
                      type: 'integer',
                      minimum: 0,
                      description:
                        'The play generation the saver opened the game on. ' +
                        'A game reset since refuses the save with 409 and ' +
                        '`details: { stale: true, generation }`.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: "Both sides' lineups as they now stand",
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GameLineups' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/games/{gameId}/dj': {
        get: {
          summary: "Both sides' batters and walk-up songs, for DJ Game",
          description:
            "Each side's batters in order, with each one's walk-up song on " +
            "that team (a placeholder has none). The order is the game's " +
            'own current lineup once TeamStation has a record of it, the ' +
            "team's default before that, and otherwise the team's players " +
            'by jersey number, then name. `canEditWalkUp` is whether the ' +
            "caller keeps that team's songs. `atBat` is the plate appearance " +
            'in progress: `side` is `away` in the top of an inning and `home` ' +
            'in the bottom, and `userId` is the batter, or null for a guest. ' +
            '`atBat` is null when no plate appearance is in progress. Needs ' +
            'somebody who can see the game; 404 for anybody else.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: '{ away, home }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['away', 'home', 'atBat'],
                    properties: {
                      away: { $ref: '#/components/schemas/DjSide' },
                      home: { $ref: '#/components/schemas/DjSide' },
                      atBat: {
                        description:
                          'The plate appearance in progress, or null.',
                        oneOf: [
                          {
                            type: 'object',
                            required: ['side', 'userId'],
                            properties: {
                              side: { enum: ['away', 'home'] },
                              userId: {
                                oneOf: [userIdSchema, { type: 'null' }]
                              }
                            }
                          },
                          { type: 'null' }
                        ]
                      }
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
      '/games/{gameId}/scoreboard-overlay': {
        get: {
          summary: "Whether a game's board shows over its videos, and where",
          description:
            "Shown for a game starting at or after the node's overlay start date, 00:00 UTC; times are compared in UTC. The placements are the node's settings, as fractions of the video from its top-left.",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'gameId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: "The game's overlay",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['show', 'single', 'landscape', 'portraitHeight'],
                    properties: {
                      show: { type: 'boolean' },
                      single: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['x', 'y', 'height'],
                        properties: {
                          x: {
                            type: 'number',
                            minimum: 0,
                            exclusiveMaximum: 1
                          },
                          y: {
                            type: 'number',
                            minimum: 0,
                            exclusiveMaximum: 1
                          },
                          height: {
                            type: 'number',
                            exclusiveMinimum: 0,
                            maximum: 1
                          }
                        }
                      },
                      landscape: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['x', 'y', 'height'],
                        properties: {
                          x: {
                            type: 'number',
                            minimum: 0,
                            exclusiveMaximum: 1
                          },
                          y: {
                            type: 'number',
                            minimum: 0,
                            exclusiveMaximum: 1
                          },
                          height: {
                            type: 'number',
                            exclusiveMinimum: 0,
                            maximum: 1
                          }
                        }
                      },
                      portraitHeight: {
                        type: 'number',
                        exclusiveMinimum: 0,
                        maximum: 1
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/scoreboard-timeline': {
        get: {
          summary: "A game's scoreboard at every moment",
          description:
            '`{ version, steps }`. Each step is `{ at, state }`: `state` is ' +
            'the board as it was drawn, `ScoreState` with every override ' +
            'applied, from `at` (epoch ms, on the server clock) until the next ' +
            "step. It is rebuilt from the game's stored plays, each scoring " +
            'action at the time it was taken (a play scored before actions ' +
            'carried times puts its actions at its own end), the score of the ' +
            'last play that had ended, and the scoreboard log of every other ' +
            'change: the publisher, the pitch-speed hold and the override ' +
            'dashboard. `version` changes whenever any of those does. A game ' +
            'with nothing on its board has no steps. 404 when there is no such ' +
            'game; 403 `membersOnly` for somebody who cannot see it. Read ' +
            'from the database alone, so it answers long after the live ' +
            'scoreboard has closed.',
          security: [{ bearer: [] }],
          parameters: [
            gameIdParam,
            {
              name: 'from',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description:
                'Epoch ms. Steps before it are left out, except the one in effect at it. Omitted, from the first step.'
            },
            {
              name: 'to',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description:
                'Epoch ms. Steps after it are left out. Omitted, to the last step. 400 when it is before `from`.'
            }
          ],
          responses: {
            200: { description: '`{ version, steps: [{ at, state }] }`' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/line-score': {
        get: {
          summary: "A game's line score at every moment, from its events",
          description:
            '`{ version, teams, steps }`. `teams` is `{ away, home }`, the ' +
            "game's team names. Each step is `{ at, line }`: `line` is " +
            '`{ away, home }`, each `{ innings, r, h, e }`, from `at` (epoch ' +
            'ms, on the server clock) until the next step. `innings[i]` is ' +
            "the side's runs in inning `i + 1`, null for a half not started; " +
            '`h` and `e` are null when the plays cannot say. It is rebuilt ' +
            "from the game's stored plays and the play in progress alone, " +
            'each scoring action at the time it was taken (a play scored ' +
            'before actions carried times puts its actions at its own end, ' +
            'and a play imported before TeamStation scored at its end), and ' +
            'never from the scoreboard log or the overrides. A game with no ' +
            'events has no steps. `version` changes whenever the events or ' +
            'the team names do. 404 when there is no such game; 403 ' +
            '`membersOnly` for somebody who cannot see it.',
          security: [{ bearer: [] }],
          parameters: [
            gameIdParam,
            {
              name: 'at',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description:
                'Epoch ms. Only the step in effect at that instant, or none before the first event. Omitted, every step (or the window `from` and `to` give). 400 with `from` or `to`.'
            },
            {
              name: 'from',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description:
                'Epoch ms. Steps before it are left out, except the one in effect at it. Omitted, from the first step.'
            },
            {
              name: 'to',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description:
                'Epoch ms. Steps after it are left out. Omitted, to the last step. 400 when it is before `from`.'
            }
          ],
          responses: {
            200: {
              description:
                '`{ version, teams: { away, home }, steps: [{ at, line }] }`'
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/halves': {
        get: {
          summary: 'One outcome per half inning',
          description:
            '`inning`, `half`, `awayScore`, `homeScore`, `outs`, and `runs`. ' +
            'Read off the stored plays. A play with no half is omitted.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: { description: '{ halves: [ ... ] }' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/swap-sides': {
        post: {
          summary: 'Swap home and away, resetting a begun game',
          description:
            'For a scorekeeper of either team, from the scoring screen. ' +
            'Before the first pitch only the teams and scores exchange: ' +
            'lineups, guests and unavailable players are kept by team and ' +
            'follow it. The lineups digest changes, so a post built on the ' +
            'old sides is refused as stale. What the call does is the `swap` ' +
            '`GET /games/{gameId}/events` answers, which also carries `modelNames` ' +
            'for a reader who may dictate about a team: each player by gumbo id, ' +
            'first name and last initial, never drawn. `swap`: an at-bat of ' +
            'lineups only, or none, and no play: the teams exchange. ' +
            '`reset`: a play or an at-bat TeamStation scored. The game is ' +
            'reset first, and the body must name the `playsDigest` and ' +
            '`generation` its caller read, or the call is refused with 409 ' +
            '"This game\'s plays changed. Open it again."; a body naming ' +
            'neither, as an app not yet updated sends, is refused with 409 ' +
            '"Home and away can be swapped only before the first pitch". ' +
            'Every play and tag is archived and deleted, the game goes back ' +
            'to its lineups at the first pitch, scheduled (a cancelled game ' +
            'stays cancelled) with no scores, and its play generation goes ' +
            'up one, so a post made on the old plays is refused. ' +
            '`scoredElsewhere` (a play or at-bat TeamStation did not score, ' +
            'or a game under way or final with nothing it scored) and ' +
            '`withdrawn` are refused with 409. The body names the ' +
            'sides the caller read: sent again once they are exchanged, the ' +
            'call answers them and changes nothing; on other sides it is ' +
            'refused with 409.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['homeTeamId', 'awayTeamId'],
                  properties: {
                    homeTeamId: { type: 'string' },
                    awayTeamId: { type: 'string' },
                    playsDigest: {
                      type: 'string',
                      description:
                        'The plays the caller confirmed losing; required to ' +
                        'reset a begun game.'
                    },
                    generation: {
                      type: 'integer',
                      description:
                        'The play generation the caller read; required to ' +
                        'reset a begun game.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                'The game’s teams after the swap, its play generation, and ' +
                'the at-bats and innings a reset deleted (none for a swap ' +
                'before the first pitch, or one already made)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'homeTeamId',
                      'awayTeamId',
                      'generation',
                      'reset'
                    ],
                    properties: {
                      homeTeamId: { type: 'string' },
                      awayTeamId: { type: 'string' },
                      generation: { type: 'integer' },
                      reset: {
                        type: 'object',
                        required: ['atBats', 'innings'],
                        properties: {
                          atBats: { type: 'integer' },
                          innings: { type: 'integer' }
                        }
                      }
                    }
                  }
                }
              }
            },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/admin/test-error': {
        post: {
          summary: 'Fail on purpose, to prove crash reporting works',
          description:
            'Site administrators only. The handler throws, as an unplanned ' +
            'bug would, so the request travels the ordinary error path: the ' +
            'reply is `internal`, and the error is reported with the ' +
            "administrator's account id.",
          security: [{ bearer: [] }],
          responses: {
            401: { description: 'Not signed in' },
            403: { description: 'Not a site administrator' },
            500: { description: 'Always, by design' }
          }
        }
      },
      '/analytics/events': {
        post: {
          summary: 'Record explicit private product events',
          description:
            'Up to 50 compact JSON records (64 KiB) as a JSON array or application/x-ndjson. Unknown fields and chat content are rejected. Identity comes from authentication. Anonymous intake permits public session, navigation, signup and failed-login events only. Repeated event ID and timestamp pairs are idempotent.',
          responses: {
            202: { description: 'Durably accepted' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            413: errorResponse,
            429: errorResponse
          }
        }
      },
      '/admin/analytics/query': {
        post: {
          summary: 'Read analytics with restricted SQL',
          description:
            'Administrator-only body {sql, parameters?}. One SELECT from analytics.events; aggregates, date_trunc, grouping and approved properties->> extraction are supported. Other tables, subqueries, joins, writes, locking and unapproved functions are rejected. A separate restricted reader enforces a two-second timeout and at most 1,000 rows / 1 MiB. Returns {rows,truncated}.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Bounded analytics result' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            503: errorResponse
          }
        }
      },
      '/games/{gameId}/box-score': {
        get: {
          summary: "A game's batting and pitching lines",
          description:
            'Added up from the stored stat lines, one row per player per ' +
            "game. The stats builder writes them whenever the game's plays " +
            'change. `stats` is where that build stands: `none` when nothing ' +
            'has asked for this game yet, `pending` while a build is owed, ' +
            '`built` when the lines match the plays, `incomplete` when a ' +
            'required Gumbo field is missing (with `detail` naming the play ' +
            'and field), or `failed` after a build threw. A game with no ' +
            'lines yet has empty `batting` and `pitching`. A withdrawn ' +
            "batting line (a rejected add's part in the game, `userId` null " +
            'under a placeholder name) has `standsFor`, the gumbo id of the ' +
            'batter it stands in for in this game, so a batting order that ' +
            'still names him shows the line instead; every other line has ' +
            '`standsFor` null. `gumboIds` are the ids a line goes by in the ' +
            "game's plays. Anybody signed in " +
            'who is a member of neither team is answered 403 `membersOnly`.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                'A line per batter and pitcher, with rates, and `stats` for ' +
                "the builder's status"
            },
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/videos/{videoId}/highlights': {
        get: {
          summary: 'Where to seek to in this video for each play',
          description:
            'Highlights are never stored: they are worked out from the plays ' +
            'and the current settings on every read, so a corrected lag or a ' +
            're-synced video fixes them all at once. A highlight is a ' +
            'timestamp into the full video, never a separate clip: it starts ' +
            'at `startOffsetSec` and stops at `endOffsetSec`, the node’s ' +
            '`highlights.tailSec` past the play or the end of the recording. When the ' +
            "game's plays did not add up to its imported line score, " +
            '`withheld` is `scoreMismatch` and the list is empty. Guests and ' +
            'nonmembers may read the list and signed stills; playback remains members-only.',
          security: [],
          parameters: [
            {
              name: 'videoId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: 'Highlights in game order, oldest first' },
            404: errorResponse
          }
        }
      },
      '/players/{userId}': {
        get: {
          summary: 'One person, for their own page',
          description:
            'Their public name, avatar, bats and throws, whether the caller ' +
            'may change their name (`canEditName`), how the caller may ' +
            'invite a guardian of them (`guardianInviteAs`), and the teams ' +
            'they have played for that the caller may see: every one to the ' +
            'person and their guardians. A merged row answers 303 to the ' +
            'person it was merged into. `forTeam` names a team the caller may ' +
            'see them on now, and the name then follows that team; anything ' +
            'else is ignored, and the name follows the most restrictive ' +
            'format of the teams they play for.',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'forTeam',
              in: 'query',
              required: false,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'The person, with `teams` newest season first',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'gumboId', 'name', 'teams'],
                    properties: {
                      userId: userIdSchema,
                      gumboId: nullableGumboIdSchema,
                      name: {
                        type: 'string',
                        description: PUBLIC_NAME
                      },
                      canEditName: { type: 'boolean' },
                      guardianInviteAs: {
                        type: ['string', 'null'],
                        enum: ['guardian', 'team', null],
                        description:
                          '`guardian`: the caller is a guardian of the person ' +
                          'and invites another with no `sender`. `team`: the ' +
                          'caller administers, coaches or assists a team the ' +
                          'person plays on now, and the person has no ' +
                          'guardian yet (a site administrator, always), so ' +
                          'invites from that team as `sender`. `null`: the ' +
                          'caller may not invite one.'
                      },
                      avatarUrl: { type: ['string', 'null'] },
                      bats: {
                        type: ['string', 'null'],
                        enum: ['left', 'right', 'switch', null]
                      },
                      throws: {
                        type: ['string', 'null'],
                        enum: ['left', 'right', null]
                      },
                      teams: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/PlayerTeam' }
                      }
                    }
                  }
                }
              }
            },
            303: { description: 'A merged row: the person it was merged into' },
            404: errorResponse
          }
        }
      },
      '/players/{userId}/stats': {
        get: {
          summary: "A player's batting and pitching, narrowed as asked",
          description:
            'Every figure is a sum of that player\u2019s per-game stat lines, ' +
            'so a total here and a line in a box score are the same rows ' +
            'added up differently. Unfiltered is a career. The answer carries ' +
            'the seasons, teams and years there are to choose from, which is ' +
            'what the filter on the page offers. `rates.era` is earned runs ' +
            "per game, a game being the season's or league's ERA innings " +
            '(six unless set), and is absent for a pitcher with no outs. ' +
            '`splits`, last in the answer, holds the rows the totals are ' +
            'the sum of: `by` `team` for a career, one row per team; `by` ' +
            '`game` under a season, team or year, one row per game with its ' +
            'opponent and side. Each of `splits.batting` and ' +
            '`splits.pitching` lists only rows with that kind of line, ' +
            'newest first, each `{ split, line }`, its rates worked out the ' +
            'same way as the totals.',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games in this season'
            },
            {
              name: 'teamId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games played for this team'
            },
            {
              name: 'year',
              in: 'query',
              schema: { type: 'integer' },
              description: 'Only games played in this calendar year'
            }
          ],
          responses: {
            200: {
              description: 'The totals, and what they can be narrowed to'
            },
            404: errorResponse
          }
        }
      },
      '/players/{userId}/highlights': {
        get: {
          summary: 'Every highlight a player is credited on, newest first',
          description:
            'A page at a time: `nextBefore` is the play time to pass as ' +
            '`before` for the next page, and `withoutVideo` counts plays on ' +
            'the page no recording covers. `seasonId`, `teamId` and `year` ' +
            'narrow the games the same way `/players/{userId}/stats` does, ' +
            'before the page is cut; `teamId` is the team the player played ' +
            'for. With none of them the answer is the career. Each highlight ' +
            'plays from `startOffsetSec` to `endOffsetSec`.',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'before',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Only plays before this moment'
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 50 },
              description: 'Page size; 20 unless set, never more than 50'
            },
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games in this season'
            },
            {
              name: 'teamId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only games played for this team'
            },
            {
              name: 'year',
              in: 'query',
              schema: { type: 'integer' },
              description: 'Only games played in this calendar year'
            }
          ],
          responses: {
            200: {
              description:
                'Highlights, newest first, with `nextBefore` and `withoutVideo`'
            },
            404: errorResponse
          }
        }
      },
      '/players/{userId}/plays': {
        get: {
          summary: 'The plays a figure was worked out from',
          security: [{ bearer: [] }],
          parameters: [
            userIdParam,
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only this season'
            },
            {
              name: 'eventType',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only this kind of play, e.g. `single`'
            },
            {
              name: 'role',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'batter',
                  'pitcher',
                  'runner',
                  'scorer',
                  'fielder',
                  'catcher'
                ]
              },
              description: 'Only plays where they had this part in it'
            }
          ],
          responses: {
            200: { description: 'The plays, newest game first' },
            401: errorResponse
          }
        }
      },
      '/seasons': {
        ...(creationPaths(errorResponse)['/seasons'] as object),
        get: {
          summary: 'The seasons you may watch',
          description:
            'Each season carries `startsOn` and `endsOn` (`YYYY-MM-DD`, or ' +
            'null), reference dates for sorting, independent of game dates. ' +
            '`team` may be repeated, and narrows the list to the seasons ' +
            'those teams play in. Asked that way, a season the caller may ' +
            'schedule games in counts as one they may see. Leaving it out ' +
            'lists every season the caller may watch.',
          security: [{}, { bearer: [] }],
          parameters: [
            {
              name: 'view',
              in: 'query',
              schema: { type: 'string', enum: ['public'] },
              description:
                'Public minimal summaries. Omitted keeps the authenticated private collection.'
            },
            {
              name: 'query',
              in: 'query',
              schema: { type: 'string', maxLength: 120, default: '' },
              description:
                'Public discovery by name or parent league locality; used with view=public'
            },
            {
              name: 'team',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: 'Teams whose seasons to list'
            }
          ],
          responses: {
            200: {
              description:
                'Explicit season viewing grants are bounded to its games. Competition membership creates no private team or season scope.'
            },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/teams': {
        get: {
          summary: "A season's teams",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description:
                'Season-owned child teams, active competition members and canonical committed game participants, including placeholders and canceled historical participants. TeamSummary adds seasonCategory inSeason/exhibition/unscheduled and canViewPrivate matching private team endpoint visibility; parent-only teams without games and canceled-only participants are unscheduled. Membership/management links are never created by this read.'
            },
            404: errorResponse
          }
        }
      },
      '/node/settings': {
        get: {
          summary: 'Every node setting, for a node administrator',
          description:
            "Where the scoreboard sits over video (fractions of the video, from its top-left: x right, y down; a height is the full board's), the overlay's start date, the pitch-speed hold and the highlight timings.",
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The node settings',
              content: {
                'application/json': {
                  schema: nodeSettingsSchema
                }
              }
            },
            401: errorResponse,
            403: errorResponse
          }
        },
        put: {
          summary: 'A node administrator sets every node setting at once',
          description:
            'Every field is required and checked: positions from 0 to under 1, heights above 0 up to 1, the speed hold above 0 up to 600 seconds, the highlight timings from 0 to 600 seconds, a real date.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: nodeSettingsSchema
              }
            }
          },
          responses: {
            200: {
              description: 'The settings as stored',
              content: {
                'application/json': {
                  schema: nodeSettingsSchema
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/node/mail': {
        get: {
          summary:
            'Whether a node administrator is sending invitations and added notices',
          description:
            'Sign-in codes are not this setting. False, the default, sends none of the other mail.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'The current account-mail switch',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['accountMessages'],
                    properties: { accountMessages: { type: 'boolean' } }
                  }
                }
              }
            },
            401: errorResponse,
            403: errorResponse
          }
        },
        put: {
          summary: 'A node administrator turns account mail on or off',
          description:
            'Invitations and notices that somebody was added follow this switch. Sign-in codes keep sending either way.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['accountMessages'],
                  properties: { accountMessages: { type: 'boolean' } }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The switch after the change',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['accountMessages'],
                    properties: { accountMessages: { type: 'boolean' } }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/users/{userId}/administration': {
        patch: {
          summary:
            'A human node administrator changes node role or reversible account suspension',
          security: [{ bearer: [] }],
          parameters: [
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
                  additionalProperties: false,
                  properties: {
                    isNodeAdmin: { type: 'boolean' },
                    suspended: { type: 'boolean' }
                  },
                  minProperties: 1
                }
              }
            }
          },
          description:
            'Requires node authority, preserves identity/history, protects the final active node and every last active direct group administrator. Suspension revokes sessions and machine tokens; reactivation requires a new sign-in. Audited without credentials.',
          responses: {
            200: { description: 'Account state changed' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/users': {
        get: {
          summary:
            'Who people are here, by the ids another service has, or the players you guard',
          description:
            'A play names people by their numeric gumboId, so a sender ' +
            'asks this with the ids it holds first. Each answer is ' +
            '`{ userId, gumboId, externalIds, shortName, avatarUrl }`: a person, ' +
            'their canonical account userId and separate scoring gumboId ' +
            '(null until allocated), ' +
            'which of the asked ids are theirs, their short name and their ' +
            'signed picture (null when none). A merged row answers as the ' +
            'person it was merged ' +
            'into. Only people you could see the page of are answered. ' +
            '`externalId` is required and may be given more than once; an ' +
            'empty one is refused. With `guardedBy=me` instead, the answer ' +
            'is the players you are a guardian of, sorted by short name, ' +
            'each with empty `externalIds`; any other `guardedBy` is 400, ' +
            'and so is `guardedBy` beside `externalId`. ' +
            'With view=administration, a signed-in node ' +
            'administrator instead receives account identity and node/suspension ' +
            'state, filtered by query (name or verified email, at most 120 ' +
            'characters). This view requires no externalId and does not alter ' +
            'the default identity-lookup response. ' +
            'With `forTeam` instead, the answer is the players a roster ' +
            'manager of that team (or, with `forGame`, a scorekeeper of either ' +
            'team in that game) may add to it: every live player, and every ' +
            'full account (switched on, with an email) though it plays for ' +
            'no team, nearest first by `tier` (`mine`: a team you are on or ' +
            "hold a role on, or a person you guard; `season`: a team in the game's " +
            "season, or any season the team is in; `league`: a team in the team's " +
            'league; `other`: everyone else, a full account that plays for no ' +
            'team among them, listed only once `q` holds three characters). ' +
            'Players already on the team, and with `forGame` ' +
            'anybody already in that game, are left out. Each row adds ' +
            '`shortParts`, `bats`, `throws`, `teams` (the teams they play for ' +
            'in a season ending today or later), `tier` and `cursor`, and ' +
            'nothing else about the person. `forTeam` beside `externalId` or ' +
            '`guardedBy` is 400. A team or game you cannot see is 404; one you ' +
            'see but may not add to is 403.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'view',
              in: 'query',
              schema: { type: 'string', enum: ['administration'] },
              description:
                'Omitted: existing external-ID lookup. administration: human node administrator account view.'
            },
            {
              name: 'query',
              in: 'query',
              schema: { type: 'string', maxLength: 120 },
              description: 'Optional account filter for administration view.'
            },
            {
              name: 'nodeAdmin',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description:
                'Administration view only: true lists only accounts with node access. Omitted or false includes all matching accounts. All matching accounts are returned.'
            },
            {
              name: 'externalId',
              in: 'query',
              required: false,
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true,
              description: "Another service's ids for the people"
            },
            {
              name: 'system',
              in: 'query',
              schema: { type: 'string', minLength: 1 },
              description: 'Restrict external IDs to this source system'
            },
            {
              name: 'forTeam',
              in: 'query',
              schema: { type: 'string', minLength: 1 },
              description:
                'Players who may be added to this team. Omitted: the other ways of asking.'
            },
            {
              name: 'forGame',
              in: 'query',
              schema: { type: 'string', minLength: 1 },
              description:
                'With forTeam: a game the team plays in. Its season ranks players, and anybody already in it is left out.'
            },
            {
              name: 'q',
              in: 'query',
              schema: { type: 'string', maxLength: 100, default: '' },
              description:
                'With forTeam: every word must start a first, last or display name, ignoring case and accents.'
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 30 },
              description: 'With forTeam: rows per page.'
            },
            {
              name: 'after',
              in: 'query',
              schema: { type: 'string' },
              description:
                'With forTeam: the cursor of the last row of the previous page.'
            },
            {
              name: 'guardedBy',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['me'] },
              description:
                'The players the caller is a guardian of, in place of externalId'
            }
          ],
          responses: {
            200: {
              description:
                'By externalId, in user id order; by guardedBy, by short name. Empty when nobody matches'
            },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/teams/search': {
        get: {
          summary: 'Find a team to follow',
          description:
            'Anybody signed in. `q` needs at least 2 characters (400 ' +
            'otherwise) and matches anywhere in the name, ignoring case. At ' +
            'most 20 full, unmerged teams, by name, each ' +
            '`{id, name, logoUrl, seasons: [{id, title}], following}`, where ' +
            'a season title is `<league> <season>` when it has a league.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              schema: { type: 'string', minLength: 2 }
            }
          ],
          responses: {
            200: { description: 'The matching teams, possibly none' },
            400: errorResponse,
            401: errorResponse
          }
        }
      },
      '/teams/{teamId}/follow': {
        put: {
          summary: 'Follow a team',
          description:
            'Anybody signed in, with nobody’s permission. A fan sees the ' +
            'team’s public listing and eligible fan chat, with no private access. ' +
            'Idempotent. A missing, external or merged team gets 404.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: '`{following: true}`' },
            401: errorResponse,
            404: errorResponse
          }
        },
        delete: {
          summary: 'Stop following a team',
          description:
            'Idempotent. A missing, external or merged team gets 404.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: '`{following: false}`' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/me/team-follows': {
        get: {
          summary: 'The teams the caller follows',
          description:
            'In the shape `GET /teams/search` answers, every one with ' +
            '`following: true`.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The followed teams, by name' },
            401: errorResponse
          }
        }
      },
      '/teams/{teamId}/schedule': {
        get: {
          summary: "A team's games, as a fan may read them",
          description:
            'For anybody who can see the team or follows it. Oldest first, ' +
            'cancelled games left out, each ' +
            '`{gameId, startsAt, homeTeam: {id, name}, awayTeam: {id, name}, ' +
            'venue}`, with no status, score, poster or video.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'The schedule' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/staff': {
        get: {
          summary: "A team's staff and their roles on it",
          description:
            'For anybody who can see the team or follows it. The people ' +
            'with a direct `admin`, `coach`, `assistant`, `scorekeeper` or `songkeeper` ' +
            'role on the team, and its owners and managers as `admin`; ' +
            'roles on its season or league do not count. Each is ' +
            '`{userId, shortName, avatarUrl, roles}`, administrators first.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'The staff' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/roster': {
        get: {
          summary:
            'Everybody on a team: administrators, staff, players, family, spectators and followers',
          description:
            'Every member of the team, every member of its seasons and its ' +
            'league, everybody given a role on the team, its seasons or its ' +
            'league, every guardian of one of its players, and everybody ' +
            'who follows it (or a team merged into it) from an account that ' +
            'is open and not disabled, each once, in the first `section` ' +
            'that fits: admin, staff, player, family, spectator, follower. ' +
            'Within a section the team\u2019s own people come first, then ' +
            'those given their place above it (`inheritedFrom`), each by ' +
            'name. Anybody signed in who is not a member of the team (the ' +
            'non-member view) reads the same roster, followers included, ' +
            'with `avatarUrl` null on every entry. ' +
            "Names follow the team's player name privacy, a first name and last " +
            'initial by default, and a row in another format says so in ' +
            '`nameFormat`. includeFullNames=true ' +
            'adds nameDetails (displayName, firstName, lastName) for roster managers: ' +
            'coach, assistant, scorekeeper or admin on this team or its parents. Others get 404. ' +
            '`walkUpSong` is the WalkUpSong the person has ' +
            'on this team, or null. Whether the caller may change the songs ' +
            'is `GET /me/roles`: `songkeeper` (which every scorekeeper ' +
            'holds) or `admin` on the team.',
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            {
              name: 'includeFullNames',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description:
                'Request private names for authorized roster management.'
            }
          ],
          responses: {
            200: {
              description: 'The roster, administrators first',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/RosterEntry' }
                  }
                }
              }
            },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/roster-players': {
        post: {
          summary: 'Create a player on a team',
          description:
            'Makes a user who cannot sign in, with no e-mail address, and a ' +
            'player membership on the team. A coach, assistant or scorekeeper ' +
            'of the team — the flag set on the team, its season or its league ' +
            '— an admin of any of those, or a site admin. Anybody else, and a ' +
            'team that does not exist, gets 404. At least one name part is ' +
            'required. `jersey` and `positions` are this membership. `bats` ' +
            'and `throws` are the player\u2019s own and are marked set by ' +
            'hand, so a roster import does not overwrite them. The person ' +
            'can be merged later because they are a real user. Audited. ' +
            'With `{ userId, jersey?, positions? }` instead, an existing player joins the ' +
            'team: 201 with their entry (short name only) and `notice.requestId` when their ' +
            'side was told, 200 when they already play for it, or 202 `{ pending: { requestId } }` ' +
            'when their side must accept first. Any other key beside `userId` is 400. ' +
            "Answers with the player's authorized roster entry, including " +
            'the whole name, as GET /teams/{teamId}/roster lists it for a ' +
            'roster manager.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'firstName',
                    'lastName',
                    'jersey',
                    'positions',
                    'bats',
                    'throws'
                  ],
                  properties: {
                    firstName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    },
                    lastName: {
                      type: 'string',
                      maxLength: PLAYER_NAME_MAX_LENGTH
                    },
                    jersey: {
                      type: 'string',
                      nullable: true,
                      maxLength: JERSEY_MAX_LENGTH,
                      description: 'Trimmed; empty or null is no number.'
                    },
                    positions: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: [...PLAYER_POSITIONS]
                      }
                    },
                    bats: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right', 'switch']
                    },
                    throws: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right']
                    }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description:
                "The new player's roster entry, as GET /teams/{teamId}/roster lists it",
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RosterEntry' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/guardians': {
        get: {
          summary: "A player's guardians and adult family members",
          description:
            'For the team’s administrators and coaches (inherited roles ' +
            'count), the player, and the player’s guardians; anybody else, ' +
            'and a user who is not a player on the team, gets 404. Each is ' +
            '`{userId, name, email, kind}`, `kind` `guardian` or `family`, ' +
            'guardians first.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          responses: {
            200: { description: 'The guardians and family' },
            401: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary: 'Link a guardian or adult family member',
          description:
            'For the team’s administrators and coaches. The body is ' +
            '`{userId}` or `{email}`, with `kind` `guardian` (the default) ' +
            'or `family`. A `userId` must be on a team the caller can see. ' +
            'An address with an account links it at once; any other address ' +
            'is sent an invitation that only that address can redeem. A ' +
            'guardian is put on the team as a member, by the link; a family ' +
            'link grants nothing. Somebody with no way to sign in is 400 with ' +
            '`details.reason` `guardianNeedsAccount`. Audited. Answers 201 ' +
            '`{guardians, invited?}`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: userIdSchema,
                    email: { type: 'string' },
                    kind: { type: 'string', enum: ['guardian', 'family'] }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: 'The guardians now, and any invitation sent' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/guardians/{guardianId}': {
        delete: {
          summary: 'Unlink a guardian or adult family member',
          description:
            'For the team’s administrators and coaches, and the guardian ' +
            'themselves. The membership the link granted goes too, unless ' +
            'they guard another player on the team, whose link then holds ' +
            'it. Audited. Answers `{removed}`.',
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            userIdParam,
            {
              name: 'guardianId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: '`{removed}`' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/players/{userId}/birth-month': {
        put: {
          summary: "Set or clear a player's birth month",
          description:
            'A year and a month, never a day: `{year, month}`, or ' +
            '`{year: null, month: null}` to clear it. Any other field is 400. ' +
            'For administrators and coaches of a team the player plays on, ' +
            'and the player’s guardians; they alone see it, as `birthMonth` ' +
            '`YYYY-MM` on `GET /players/{userId}`. Anybody else gets 404. ' +
            'Audited. Answers `{userId, birthMonth}`.',
          security: [{ bearer: [] }],
          parameters: [userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['year', 'month'],
                  additionalProperties: false,
                  properties: {
                    year: { type: ['integer', 'null'] },
                    month: {
                      type: ['integer', 'null'],
                      minimum: 1,
                      maximum: 12
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: '`{userId, birthMonth}`' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations': {
        get: {
          summary: 'The chats the caller is in',
          description:
            'Scope chats (Staff, Members and Fans of a team; Staff, All Staff ' +
            'and Announcements of a season; a league’s Org) and DMs, each ' +
            '`{id, kind, title, scope, scopeName, lastSeq, lastMessageAt, ' +
            'unread, canPost, canModerate, locked, noHolder, closed, ' +
            'memberCount, people}`. `title` and `scopeName` are null for a ' +
            'DM; `people` lists, for a DM, everybody else who was in it ' +
            'with the caller as `{userId, shortName, left, avatarUrl}` (current ' +
            'members, and those who left after the caller joined), and is ' +
            'empty for a scope chat. `lastMessageAt` is null before the ' +
            'first message. Somebody who is not an account, or is under ' +
            '13 by birth month, is in none. Additive `preferences` describes ' +
            'only the caller: `{pinned, muted, manualUnread, manualUnreadRevision}`. ' +
            '`lastPostId`, `lastPostSeq`, `lastPostAt` describe the latest post, ' +
            'including a deleted post; edits, reactions and preferences do not change post recency. ' +
            'Additive `avatarName` and `avatarUrl` describe the scope’s own identity ' +
            'and signed image URL, or null for a DM. DM people have an optional ' +
            '`avatarUrl`, null for former members. Older responses may omit these fields.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The chats' },
            401: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/preferences': {
        patch: {
          summary: 'Update personal conversation preferences',
          description:
            'Current members only. Accepts one or more boolean fields: pinned, muted, manualUnread. Never changes membership, message timestamps or public read receipts. Setting manualUnread increments its revision. Only the caller and their signed-in clients see these preferences.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  properties: {
                    pinned: { type: 'boolean' },
                    muted: { type: 'boolean' },
                    manualUnread: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Personal preferences and unread revision' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/pins': {
        get: {
          summary: 'List personal message pins',
          description:
            'Current members only. Returns only the caller’s [{messageId, pinnedAt}], newest pin first. Contains no decrypted message content.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          responses: {
            200: { description: 'Personal pin references' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/pins/{messageId}': {
        put: {
          parameters: [
            conversationIdParam,
            {
              name: 'messageId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          summary: 'Pin a message personally',
          description:
            'Current members only; the target is an uncleared post in this conversation. Idempotent. Returns the caller’s complete personal pin list; not a shared conversation pin.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Personal pin references' },
            401: errorResponse,
            404: errorResponse
          }
        },
        delete: {
          parameters: [
            conversationIdParam,
            {
              name: 'messageId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          summary: 'Unpin a message personally',
          description:
            'Current members only. Idempotent. Returns the caller’s complete personal pin list.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Personal pin references' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/members': {
        get: {
          summary: "A chat's members",
          description:
            'For members only; anybody else gets 404. Each is `{userId, ' +
            'shortName, avatarUrl, label, isModerator, isApprover, eligible, ' +
            'hasIdentity, identityKey, generation}`.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          responses: {
            200: { description: 'The members' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/reads': {
        get: {
          summary: "Every member's read cursor",
          description:
            'For members only. `[{userId, seq}]` for every member with a ' +
            'cursor.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          responses: {
            200: { description: 'The cursors' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/log': {
        get: {
          summary: "A chat's membership log",
          description:
            'For members only. The hash-chained rows after `after` (0 for ' +
            'all), oldest first, at most 1,000: `{seq, event, userId, ' +
            'actorUserId, reason, prevHash, hash, at}`, the hashes in ' +
            'base64url and `at` in milliseconds.',
          security: [{ bearer: [] }],
          parameters: [
            conversationIdParam,
            {
              name: 'after',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0 }
            }
          ],
          responses: {
            200: { description: 'The rows' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/dm-candidates': {
        get: {
          summary: 'The people the caller may start a DM with',
          description:
            'Exactly those the DM rules let the caller name, whose name holds ' +
            '`q`, at most 50: `{userId, shortName, avatarUrl}`. Empty for ' +
            'somebody whose only tie is following a team.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'userId',
              in: 'query',
              required: false,
              description:
                'Optional exact recipient filter (merged identities resolve to the surviving user); omitted returns all matching candidates.',
              schema: { type: 'string' }
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: 'The candidates' },
            401: errorResponse
          }
        }
      },
      '/chat/included-adults': {
        get: {
          summary: 'Adults to include beside players (MAAPP)',
          description:
            'For players the caller may name (comma-separated `playerIds`); ' +
            'otherwise 403 `notCandidate`. Without `q`: their guardians, ' +
            'adult family members and immediate coaches; with `q`: every ' +
            'included adult (guardians, family, adult team, season and ' +
            'league staff) whose name holds it. Never the caller. Each is ' +
            '`{userId, shortName, label}`.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'playerIds',
              in: 'query',
              required: true,
              schema: { type: 'string' }
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: { description: 'The adults' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/dms': {
        post: {
          summary: 'Start a DM',
          description:
            '`{userIds}`: 1 to 19 others (400 `dmSize` otherwise). Each must ' +
            'be somebody the caller may name, and the DM must keep the pair ' +
            'rule (403 `notCandidate` with `userIds` or `playerIds`) and, in ' +
            'a SafeSport LAO league, the MAAPP rule (409 `adultRequired` with ' +
            '`playerIds`). An open one-to-one between the same two is ' +
            'answered 200 instead of a new one (201). Answers the chat as ' +
            '`GET /chat/conversations` lists it. Audited.',
          security: [{ bearer: [] }],
          requestBody: userIdsBody,
          responses: {
            200: { description: 'The open one-to-one already there' },
            201: { description: 'The new DM' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/dms/{conversationId}/members': {
        post: {
          summary: 'Add people to a DM',
          description:
            'For a member of the DM; anybody else gets 404. The same rules ' +
            'as starting one, and never past 20 members. A closed DM is 409 ' +
            '`closed`. Answers `{added}`. Audited.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          requestBody: userIdsBody,
          responses: {
            200: { description: '`{added}`' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/dms/{conversationId}/members/me': {
        delete: {
          summary: 'Leave a DM',
          description:
            'Always allowed for a member. When those left break the pair ' +
            'rule or the MAAPP rule, the DM closes. Answers `{left, ' +
            'closed}`. Audited.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          responses: {
            200: { description: '`{left, closed}`' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/devices': {
        post: {
          summary: 'Register this device for chat',
          description:
            '`{name, platform, boxPublicKey, signPublicKey}` (X25519 and ' +
            'Ed25519 public keys, base64url). The device is bound to the ' +
            'session (taking the binding from any other device on it) and ' +
            'holds no keys until it enrols, is linked or resets. A machine ' +
            'token is refused (403 `sessionRequired`), on every chat key ' +
            'route. Answers the device as `GET /chat/devices` lists it. ' +
            'Notifies `{u, k: devices}`. Audited.',
          security: [{ bearer: [] }],
          requestBody: keyBody({
            name: { type: 'string' },
            platform: { type: 'string', enum: ['web', 'ios', 'android'] },
            boxPublicKey: b64,
            signPublicKey: b64
          }),
          responses: {
            201: { description: 'The device' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse
          }
        },
        get: {
          summary: "The caller's chat devices",
          description:
            'Revoked ones included, oldest first: `{id, name, platform, ' +
            'boxPublicKey, signPublicKey, createdAt, lastSeenAt, revokedAt, ' +
            'linked, current}`. `linked`: holds the current per-user key ' +
            'generation and is not revoked; `current`: bound to this session.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The devices' },
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/chat/devices/{deviceId}': {
        delete: {
          summary: 'Revoke a chat device',
          description:
            "One of the caller's devices, from a linked device or from the " +
            'device itself (signing out); otherwise 403 `notHolder`. Its ' +
            'session is ended. When it held the current identity, every chat ' +
            'of the user is flagged for a new epoch and `GET /chat/me/keys` ' +
            'reports `pukNeedsRotation`. Revoking again changes nothing. ' +
            '`?keepSession=true` revokes the device bound to this session ' +
            'and keeps the session signed in (a device whose saved keys ' +
            'cannot be read, reset in place); 403 `notThisDevice` for any ' +
            'other device. Audited.',
          security: [{ bearer: [] }],
          parameters: [
            pathParam('deviceId'),
            {
              name: 'keepSession',
              in: 'query',
              schema: { type: 'boolean' },
              description:
                'Keep the session signed in; only for the device bound to it.'
            }
          ],
          responses: {
            200: { description: 'The device' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/devices/{deviceId}/resume-challenge': {
        post: {
          summary: 'A nonce to resume a device with',
          description:
            '`{nonce, sessionId, expiresAt}`: 32 random bytes, good once and ' +
            'for two minutes, and the session the signature must name. 403 ' +
            '`unknownDevice` for a device the server does not have or that is ' +
            "another user's, `deviceRevoked` for a revoked one.",
          security: [{ bearer: [] }],
          parameters: [pathParam('deviceId')],
          responses: {
            200: { description: 'The challenge' },
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/chat/devices/{deviceId}/resume': {
        post: {
          summary: 'Bind a device to this session again',
          description:
            "`{nonce, signature}`: the device's Ed25519 signature over " +
            '`lp(nonce) ‖ lp(deviceId) ‖ lp(sessionId)`. The nonce is spent ' +
            'by the attempt. 403 `badChallenge` (unknown, used or expired ' +
            'nonce), `badSignature`, `unknownDevice` or `deviceRevoked`. ' +
            'Answers the device. Audited.',
          security: [{ bearer: [] }],
          parameters: [pathParam('deviceId')],
          requestBody: keyBody({ nonce: b64, signature: b64 }),
          responses: {
            200: { description: 'The device' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/chat/identity': {
        put: {
          summary: 'Enrol: publish the first identity',
          description:
            "The identity's id and public key, PUK generation 1's public key " +
            "with the identity's signature over `identity(userId) ‖ u64(1) ‖ " +
            "lp(publicKey)`, and the PUK private key boxed to this session's " +
            'device. `identity(userId)` is the eight-byte big-endian value ' +
            'for legacy account values through 2^53−1, otherwise `ff` followed ' +
            'by the full sixteen-byte big-endian value. The box uses ' +
            'HPKE `puk`; the device is then linked. 409 ' +
            '`identityExists` the second time, `idTaken` for a used id; 400 ' +
            '`badSignature`; 403 `noDevice` without a registered device. ' +
            'Opens a grant request (notifying `grant`) in every chat of the ' +
            "user's that has an epoch. Answers `{identityId, generation, " +
            'grantRequests}`. Audited.',
          security: [{ bearer: [] }],
          requestBody: identityBody,
          responses: {
            201: { description: 'Enrolled' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/identity/reset': {
        post: {
          summary: 'Replace the identity from the device in hand',
          description:
            'The same body as enrolling. The old identity is replaced; every ' +
            "other device of the user's is revoked and its session ended; in " +
            'every chat of the user an `identityReset` row is logged, a new ' +
            'epoch flagged, and a grant request only an approver may fill ' +
            'opened where there is an epoch. 409 `noIdentity` with nothing ' +
            'to reset. Answers `{identityId, generation, revokedDeviceIds}`. ' +
            'Audited.',
          security: [{ bearer: [] }],
          requestBody: identityBody,
          responses: {
            201: { description: 'Reset' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/puk': {
        post: {
          summary: 'Post the next per-user key generation',
          description:
            'From a linked device (403 `notHolder` otherwise): `{generation, ' +
            'publicKey, signature, previousKeysBox, boxes: [{deviceId, ' +
            'box}]}`. `generation` must be the current one plus 1 (409 ' +
            '`generationTaken`), signed by the current identity (400 ' +
            '`badSignature`), and boxed to exactly the linked devices at the ' +
            'current generation (400 `boxSet`). Flags every chat of the user ' +
            'for a new epoch and opens grant requests at the new generation. ' +
            'Answers `{generation, grantRequests}`. Audited.',
          security: [{ bearer: [] }],
          requestBody: keyBody({
            generation: { type: 'integer', minimum: 2 },
            publicKey: b64,
            signature: b64,
            previousKeysBox: b64,
            boxes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { deviceId: { type: 'string' }, box: b64 }
              }
            }
          }),
          responses: {
            201: { description: 'Posted' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/me/keys': {
        get: {
          summary: "The caller's keys, as this device holds them",
          description:
            '`{deviceId, linked, identity: {id, publicKey, createdAt} | ' +
            'null, generations: [{generation, publicKey, signature, ' +
            'previousKeysBox, box}], pukNeedsRotation}`: every generation of ' +
            "the current identity with this session's device's box of it.",
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The keys' },
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/chat/users/{userId}/keys': {
        get: {
          summary: "Somebody's current identity and per-user key",
          description:
            'For a user who is or was a member of a chat the caller is in ' +
            'now (or the caller); 404 otherwise. `{userId, identity: {id, ' +
            'publicKey, createdAt} | null, puk: {generation, publicKey, ' +
            'signature} | null}`.',
          security: [{ bearer: [] }],
          parameters: [userIdParam],
          responses: {
            200: { description: 'The keys' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/identities/{identityId}': {
        get: {
          summary: 'An identity, current or replaced',
          description:
            '`{id, userId, publicKey, createdAt, replacedAt}`, with the same ' +
            'reach as a user’s keys; 404 otherwise.',
          security: [{ bearer: [] }],
          parameters: [pathParam('identityId')],
          responses: {
            200: { description: 'The identity' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/links': {
        post: {
          summary: 'Ask to link this device',
          description:
            "This session's device, not yet linked (409 `alreadyLinked`), " +
            "asks the user's linked devices for the identity. 409 " +
            '`noIdentity` or `noLinkedDevice` (reset instead), 403 ' +
            '`noDevice`. Lasts ten minutes. Answers `{id, newDeviceId, ' +
            'createdAt, expiresAt, approved, expired, approvedByDeviceId, ' +
            'box}`. Notifies `{u, k: link}`. Audited.',
          security: [{ bearer: [] }],
          responses: {
            201: { description: 'The link' },
            401: errorResponse,
            403: errorResponse,
            409: errorResponse
          }
        },
        get: {
          summary: 'Open link requests',
          description:
            "The user's unapproved, unexpired requests from unrevoked " +
            'devices: `{id, newDevice: {id, name, platform, boxPublicKey}, ' +
            'createdAt, expiresAt}`. Both screens show the six digits of ' +
            '`linkCode(boxPublicKey, id)`.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The requests' },
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/chat/links/{linkId}': {
        get: {
          summary: 'One link request',
          description:
            "One of the user's links, with `box` once approved; 404 " +
            'otherwise. The new device polls it.',
          security: [{ bearer: [] }],
          parameters: [pathParam('linkId')],
          responses: {
            200: { description: 'The link' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/links/{linkId}/approve': {
        post: {
          summary: 'Approve a link',
          description:
            'From a linked device of the same user (403 `notHolder`): `{box, ' +
            'pukBoxes: [{generation, box}]}`, the identity private key boxed ' +
            'to the new device (HPKE `link`) and one PUK box per generation ' +
            '(HPKE `puk`; 400 `boxSet` otherwise). 409 `linkExpired`, ' +
            '`linkApproved`; 403 `deviceRevoked` for a revoked new device. ' +
            'Answers the link. Notifies `{u, k: link}`. Audited.',
          security: [{ bearer: [] }],
          parameters: [pathParam('linkId')],
          requestBody: keyBody({
            box: b64,
            pukBoxes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { generation: { type: 'integer' }, box: b64 }
              }
            }
          }),
          responses: {
            200: { description: 'The approved link' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/epochs': {
        get: {
          summary: "A chat's epochs and the caller's boxes",
          description:
            'For members only. `{latest, needsRotation, noHolder, epochs, ' +
            'boxes}`: `epochs` after `after` (0 for all), oldest first, each ' +
            '`{epoch, createdByUserId, identityId, previousKeyBox, ' +
            'chainBreak, signature, createdAt}`; `boxes` are the caller’s ' +
            'epoch keys under their current identity, from epoch `after` on, ' +
            'each `{epoch, identityId, pukGeneration, box, grantedByUserId}` ' +
            '(HPKE `epoch`, or `grant` when `grantedByUserId` is set). Bytes ' +
            'are base64url.',
          security: [{ bearer: [] }],
          parameters: [
            conversationIdParam,
            {
              name: 'after',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0 }
            }
          ],
          responses: {
            200: { description: 'The epochs and boxes' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary: 'Make the next epoch',
          description:
            'From a member’s linked device (403 `notHolder` otherwise): ' +
            '`{epoch, previousKeyBox, signature, boxes: [{userId, ' +
            'pukGeneration, box}]}`. `epoch` is the latest plus 1 (409 ' +
            '`epochTaken` when somebody made it first; 400 `epochGap` past ' +
            'it). Epoch 1 has no `previousKeyBox` and may come from any ' +
            'eligible member. A later one needs a creator holding the latest ' +
            'epoch and its `previousKeyBox` (403 `notHolder`), unless no ' +
            'current member holds it: then any member with an identity makes ' +
            'it with no `previousKeyBox`, as a chain break, which supersedes ' +
            'every open grant request. The signature is the creator’s current ' +
            'identity’s (400 `badSignature`). The boxes name exactly the ' +
            'eligible members (at a chain break, every member with an ' +
            'identity) at their current generations (400 `boxSet`). Clears ' +
            '`needs_rotation`, fills the boxed members’ requests, opens ' +
            'requests for the rest, notifies `epoch`. A closed chat is 409 ' +
            '`closed`. Answers `{epoch, chainBreak, boxed, grantRequests}`. ' +
            'Audited.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          requestBody: keyBody({
            epoch: { type: 'integer', minimum: 1 },
            previousKeyBox: { ...b64, nullable: true },
            signature: b64,
            boxes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: userIdSchema,
                  pukGeneration: { type: 'integer' },
                  box: b64
                }
              }
            }
          }),
          responses: {
            201: { description: 'Made' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/grants': {
        get: {
          summary: 'Open grant requests in the caller’s chats',
          description:
            'Every open request of a current member in a chat the caller is ' +
            'in, oldest first: `{id, conversationId, epoch, userId, ' +
            'identityId, identityKey, pukGeneration, pukPublicKey, ' +
            'pukSignature, identityReset, canApprove, openedAt}`. `epoch` is ' +
            'the latest, the one to box; `identityReset` marks an identity ' +
            'that replaced one the chat had seen, which only an approver ' +
            '(`canApprove`) may fill; `canApprove` is false on the caller’s ' +
            'own reset request.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'The requests' },
            401: errorResponse,
            403: errorResponse
          }
        },
        post: {
          summary: 'Fill grant requests',
          description:
            'From a linked device (403 `notHolder`): `{boxes: [{conversationId, ' +
            'epoch, userId, identityId, pukGeneration, box}]}`, 1 to 500 (400 ' +
            'otherwise), each the latest epoch’s key boxed (HPKE `grant`) to ' +
            'an open request. The caller must be a member holding the latest ' +
            'epoch of each chat named (404, 403 `notHolder`) and an approver ' +
            'for a reset identity other than their own (403 `notApprover`); ' +
            'any refusal refuses the ' +
            'whole batch. A box for an older epoch or a request no longer ' +
            'open is skipped. Closes each request it fills and notifies ' +
            '`grant`. Answers `{filled, skipped: [{conversationId, userId, ' +
            'identityId, pukGeneration, reason}]}`. Audited.',
          security: [{ bearer: [] }],
          requestBody: keyBody({
            boxes: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                properties: {
                  conversationId: { type: 'string' },
                  epoch: { type: 'integer' },
                  userId: userIdSchema,
                  identityId: { type: 'string' },
                  pukGeneration: { type: 'integer' },
                  box: b64
                }
              }
            }
          }),
          responses: {
            200: { description: 'Filled' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/messages': {
        get: {
          summary: "A chat's messages",
          description:
            'For members only, oldest first: the first `limit` (default ' +
            '100, at most 500) with `seq` after `after`, or, given only ' +
            '`before`, the last `limit` before it. Each is `{id, ' +
            'conversationId, seq, epoch, senderUserId, senderIdentityId, ' +
            'kind, targetIds, nonce, ciphertext, signature, attachmentIds, ' +
            'clearedAt, createdAt}`; a cleared message has an empty ' +
            '`ciphertext`. Bytes are base64url.',
          security: [{ bearer: [] }],
          parameters: [
            conversationIdParam,
            ...['after', 'before', 'limit'].map(name => ({
              name,
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0 }
            }))
          ],
          responses: {
            200: { description: 'The messages' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        },
        post: {
          summary: 'Post a message',
          description:
            'From a member’s linked device (403 `notHolder`): `{id, epoch, ' +
            'kind, senderIdentityId, targetIds?, attachmentIds?, nonce, ' +
            'ciphertext, signature}`. `id` is the client’s `msg_` id: a ' +
            'repeat by the same sender in the same chat answers 200 with the ' +
            'stored row, the id anywhere else is 409 `idTaken`. `kind` is ' +
            '`post`, `reaction`, `edit`, `delete` or `moderatorDelete`; ' +
            '`targetIds` come with the two deletes and nothing else, ' +
            '`attachmentIds` (completed uploads by the sender in this chat, ' +
            '400 `attachment`) with posts only (400 otherwise). The ' +
            'ciphertext is at most 64 KiB. 409: `closed`, `staleIdentity` ' +
            '(not the sender’s current identity), `staleEpoch` (not the ' +
            'latest epoch), `locked` (no box for it). In Announcements only ' +
            'season staff post, edit and delete (403 `notStaff`); anybody ' +
            'reacts. `delete` targets the sender’s own messages (403 ' +
            '`notYours`), `moderatorDelete` needs a moderator (403 ' +
            '`notModerator`); targets are posts, edits or reactions in this ' +
            'chat (400 `target`). Both clear their targets and delete the ' +
            'attachments only those referenced. The signature is the ' +
            'sender identity’s (400 `badSignature`). Notifies `message` with ' +
            'the `seq`. Answers 201 with the message. Not audited.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          requestBody: keyBody({
            id: { type: 'string', pattern: '^msg_[a-z2-7]{26}$' },
            epoch: { type: 'integer', minimum: 1 },
            kind: {
              type: 'string',
              enum: ['post', 'reaction', 'edit', 'delete', 'moderatorDelete']
            },
            senderIdentityId: { type: 'string' },
            nonce: b64,
            ciphertext: b64,
            signature: b64
          }),
          responses: {
            200: { description: 'The stored message, for a repeat' },
            201: { description: 'Posted' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/conversations/{conversationId}/read': {
        put: {
          summary: 'Move the read cursor',
          description:
            'For members only: `{seq}`, at most the chat’s last `seq` (400 ' +
            '`seq`). The cursor never moves back; a move notifies `read`. ' +
            'Optional `clearManualUnreadRevision` clears personal manual unread only ' +
            'when it matches the current revision, so an older in-flight read cannot ' +
            'clear a later Mark unread. Answers `{seq}` as the cursor stands. Not audited.',
          security: [{ bearer: [] }],
          parameters: [conversationIdParam],
          requestBody: keyBody(
            {
              seq: { type: 'integer', minimum: 0 },
              clearManualUnreadRevision: { type: 'integer', minimum: 0 }
            },
            ['seq']
          ),
          responses: {
            200: { description: 'The cursor' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/reports': {
        post: {
          summary: 'Report a message',
          description:
            'By a member of its chat (404 otherwise): `{messageId, ' +
            'plaintext, messageKey}`, the message’s own key (base64url, 32 ' +
            'bytes), never the epoch’s. The server copies the message into ' +
            'the report and stores it `verified` when the sender’s signature ' +
            'holds and opening the ciphertext with the key gives exactly the ' +
            'plaintext. A deleted message is 409 `cleared`. Answers 201 ' +
            '`{id, verified}`. Audited.',
          security: [{ bearer: [] }],
          requestBody: keyBody({
            messageId: { type: 'string' },
            plaintext: { type: 'string' },
            messageKey: b64
          }),
          responses: {
            201: { description: 'Reported' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/chat/attachments': {
        post: {
          summary: 'Open an encrypted attachment upload',
          description:
            'In a chat the caller may post in (404 for a non-member, 403 ' +
            '`readOnly` for an Announcements reader or a closed chat): ' +
            '`{conversationId, size, digest}`, the sealed blob’s length (1 ' +
            'to what a 100 MiB file seals to) and its SHA-256 (base64url, ' +
            '32 bytes). Answers 201 `{id, conversationId, size, completed: ' +
            'false, partSize, parts, missing}`: send `parts` parts of ' +
            '`partSize` (8 MiB) bytes, the last short. 400 `noSpace` when ' +
            'the server has no Space. Needs a signed-in session. Audited.',
          security: [{ bearer: [] }],
          requestBody: keyBody({
            conversationId: { type: 'string' },
            size: { type: 'integer', minimum: 1 },
            digest: b64
          }),
          responses: {
            201: { description: 'Opened' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/attachments/{attachmentId}': {
        get: {
          summary: 'An encrypted attachment',
          description:
            'For a member of its chat: a finished attachment as `{id, ' +
            'conversationId, size, digest, completed: true, url, ' +
            'expiresAt}`, `url` a presigned GET of the blob good for 10 ' +
            'minutes. To its uploader, an unfinished one as `{…, completed: ' +
            'false, partSize, parts, missing}`, so an interrupted upload ' +
            'sends only what is missing. Anybody else gets 404.',
          security: [{ bearer: [] }],
          parameters: [pathParam('attachmentId')],
          responses: {
            200: { description: 'The attachment' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/chat/attachments/{attachmentId}/parts/{index}': {
        put: {
          summary: 'One part of an attachment',
          description:
            'The uploader’s, while unfinished: the raw bytes of part ' +
            '`index` (from 0), exactly `partSize` bytes but the last. ' +
            'Sending one again replaces it. Answers `{received, parts, ' +
            'missing}`. 400 `part` for a wrong index or length, 413 `part` ' +
            'over 9 MiB, 409 `completed` once finished. Not audited.',
          security: [{ bearer: [] }],
          parameters: [pathParam('attachmentId'), pathParam('index')],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          responses: {
            200: { description: 'Stored' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse,
            413: errorResponse
          }
        }
      },
      '/chat/attachments/{attachmentId}/complete': {
        post: {
          summary: 'Finish an attachment',
          description:
            'The uploader’s, with every part sent (409 `partsMissing` with ' +
            '`missing` otherwise): the parts are joined and must hash to the ' +
            'declared digest (400 `digestMismatch`, and the parts are ' +
            'dropped), then the blob goes to the Space at ' +
            '`chat/<conversationId>/<attachmentId>`. Answers `{id, ' +
            'conversationId, size, digest, completed: true}`; again, the ' +
            'same. Audited.',
          security: [{ bearer: [] }],
          parameters: [pathParam('attachmentId')],
          responses: {
            200: { description: 'Finished' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/admin/chat/reports': {
        get: {
          summary: 'Reported messages',
          description:
            'Site administrators only. Newest first, at most 500; only the ' +
            'unresolved with `open=true`. Each is `{id, conversation: {id, ' +
            'kind, title}, messageId, reporter: {userId, shortName}, sender: ' +
            '{userId, shortName}, kind, sentAt, plaintext, verified, ' +
            'createdAt, resolvedAt}`.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'open',
              in: 'query',
              required: false,
              schema: { type: 'boolean' }
            }
          ],
          responses: {
            200: { description: 'The reports' },
            401: errorResponse,
            403: errorResponse
          }
        }
      },
      '/admin/chat/reports/{reportId}/resolve': {
        put: {
          summary: 'Resolve a report',
          description:
            'Site administrators only. Marks the report resolved (once) and ' +
            'answers it as the list shows it. Audited.',
          security: [{ bearer: [] }],
          parameters: [pathParam('reportId')],
          responses: {
            200: { description: 'The report' },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/settings': {
        put: {
          summary: "Set a player's name, jersey, positions, bats and throws",
          description:
            'For a coach, assistant or scorekeeper of the team — the flag ' +
            'set on the team, its season or its league — an admin of any of ' +
            'those, a guardian of the player, or a site admin. ' +
            'Anybody else, and a user who is not a player on the team, gets ' +
            '404. Send only the fields to change; a body with none is 400. ' +
            "`jersey` and `positions` are the player's place on this team. " +
            "`bats` and `throws` are the player's own and read the same on " +
            'every team; setting either marks them set by hand, so a ' +
            'roster import no longer overwrites them. Audited. ' +
            'The optional `name` replaces both trimmed name parts, with at least ' +
            'one nonblank part; it also requires permission to edit the player name. ' +
            'All submitted changes save atomically. ' +
            "Answers with the player's authorized roster entry as it now reads.",
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  properties: {
                    name: {
                      type: 'object',
                      required: ['firstName', 'lastName'],
                      properties: {
                        firstName: {
                          type: 'string',
                          maxLength: PLAYER_NAME_MAX_LENGTH
                        },
                        lastName: {
                          type: 'string',
                          maxLength: PLAYER_NAME_MAX_LENGTH
                        }
                      },
                      description:
                        'Trimmed; at least one part must be nonblank.'
                    },
                    jersey: {
                      type: 'string',
                      nullable: true,
                      maxLength: JERSEY_MAX_LENGTH,
                      description: 'Trimmed; empty or null is no number.'
                    },
                    positions: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: [...PLAYER_POSITIONS]
                      },
                      description:
                        'Replaces every position; stored once each, in this order.'
                    },
                    bats: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right', 'switch']
                    },
                    throws: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right']
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description:
                "The player's roster entry, as GET /teams/{teamId}/roster lists it",
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RosterEntry' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/players/{userId}/settings': {
        put: {
          summary: 'Set how a player bats and throws',
          description:
            'The hands are the player\u2019s own and read the same on every ' +
            'team. For a guardian of the player, a coach, assistant, ' +
            'scorekeeper or admin of any team the player plays on, or a site ' +
            'admin; anybody else, and a ' +
            'merged row, gets 404. Only `bats` and `throws` are accepted: ' +
            '`jersey` and `positions` belong to a team ' +
            '(PUT /teams/{teamId}/players/{userId}/settings) and are 400 ' +
            'here, as is a body that changes nothing. Setting either hand ' +
            'marks them set by hand, so a roster import no longer ' +
            'overwrites them. Audited as `playerSettings`.',
          security: [{ bearer: [] }],
          parameters: [userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  properties: {
                    bats: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right', 'switch']
                    },
                    throws: {
                      type: 'string',
                      nullable: true,
                      enum: ['left', 'right']
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The hands as they now read',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'bats', 'throws'],
                    properties: {
                      userId: userIdSchema,
                      bats: {
                        type: 'string',
                        nullable: true,
                        enum: ['left', 'right', 'switch']
                      },
                      throws: {
                        type: 'string',
                        nullable: true,
                        enum: ['left', 'right']
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/players/{userId}/walk-up-song': {
        put: {
          summary: "Set a player's walk-up song on a team",
          description:
            'For a songkeeper or scorekeeper of the team — the flag set on ' +
            'the team, its season or its league — an admin of any of those, ' +
            'a guardian of the player, or a site ' +
            'admin. Anybody else, and a user who is not a player on the ' +
            'team, gets 404; a bad body is 400. Replaces any song the player ' +
            'had on the team. Audited, and announced on the game socket as a ' +
            '`walkUpSong` change to every subscribed game the team plays in. ' +
            'Answers with the song as stored.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WalkUpSong' }
              }
            }
          },
          responses: {
            200: {
              description: 'The song as stored',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalkUpSong' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        delete: {
          summary: "Remove a player's walk-up song on a team",
          description:
            'The same rights as setting one. Removing a song the player does ' +
            'not have is also 204. Audited, and a removal is announced on the ' +
            'game socket with `song: null`.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam, userIdParam],
          responses: {
            204: { description: 'The player has no song on the team' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/stats': {
        get: {
          summary: "A team's batting or pitching",
          description:
            'For members. Anybody else signed in is answered 403 ' +
            '`membersOnly`; a team that is not there (or merged into ' +
            'another), 404.',
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            {
              name: 'kind',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['batting', 'pitching'],
                default: 'batting'
              }
            },
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'One season, or every season when unset'
            }
          ],
          responses: {
            200: { description: 'A row per player' },
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/director/events/{gameId}/stream': {
        get: {
          summary: 'What this Director\u2019s camera on a game is doing',
          description:
            'Asked when a publish fails: the ingest writes why on the row, ' +
            'and that sentence beats the socket\u2019s, which can only say ' +
            'that a connection closed. The camera is the one the claim ' +
            'resolves.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: 'The state of this account\u2019s camera',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      gameId: { type: 'string' },
                      state: { type: 'string' },
                      lastError: { type: ['string', 'null'] }
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
      '/invites': {
        get: {
          summary: 'The invite codes for one league, season or team',
          description:
            'Answers `canInvite: false` with an empty list for somebody who ' +
            'can see the page but does not administer it, so the panel ' +
            'simply does not draw itself.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'scopeType',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['league', 'season', 'team'] }
            },
            {
              name: 'scopeId',
              in: 'query',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'What may be done here, and what is already made',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['canInvite', 'invites'],
                    properties: {
                      canInvite: { type: 'boolean' },
                      invites: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Invite' }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse
          }
        },
        post: {
          summary: 'Make an invite code',
          description:
            'Administrators only, of the very league, season or team named ' +
            '— and rights inherit downwards, so a league administrator may ' +
            'invite to any of its teams. A code of your own is allowed; ' +
            'left out, one is generated.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['scopeType', 'scopeId'],
                  properties: {
                    scopeType: {
                      type: 'string',
                      enum: ['league', 'season', 'team']
                    },
                    scopeId: { type: 'string' },
                    code: { type: 'string' },
                    label: { type: 'string' },
                    maxUses: { type: 'integer', minimum: 1 },
                    expiresAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'The invite, with the address to hand out',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Invite' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/invites/{id}': {
        delete: {
          summary: 'Stop an invite code',
          description:
            'The row stays, so who came in through it can still be read.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            204: { description: 'Stopped' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/join/{code}': {
        get: {
          summary: 'What an invite code is worth',
          description:
            'Answered whether or not anybody is signed in: somebody with no ' +
            'account has to be told what they are being invited to before ' +
            'they hand over an address. An unknown code answers 404.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'The invitation',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InviteInfo' }
                }
              }
            },
            404: errorResponse
          }
        }
      },
      '/join/{code}/redeem': {
        post: {
          summary: 'Take up an invitation as whoever is signed in',
          description:
            '`granted` is false when they already had the access, which is ' +
            'not a failure and does not cost the invite a use.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description: 'What they were let into',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['granted', 'scope'],
                    properties: {
                      granted: { type: 'boolean' },
                      scope: {
                        type: 'object',
                        properties: {
                          kind: {
                            type: 'string',
                            enum: ['league', 'season', 'team']
                          },
                          id: { type: 'string' },
                          name: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/join/{code}/email-code': {
        post: {
          summary: 'Ask for a sign-in code that carries this invitation',
          description:
            'The way somebody with no account comes in through a link. The ' +
            'account is made when that code is typed or its link opened — ' +
            'never here — so an address nobody can read gets nowhere. The ' +
            'answer is the same whether or not the address already has an ' +
            'account.',
          parameters: [
            {
              name: 'code',
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
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string' },
                    displayName: {
                      type: 'string',
                      description: 'What an account made by this will be called'
                    },
                    origin: {
                      type: 'string',
                      enum: ['web', 'ios', 'android'],
                      default: 'web'
                    },
                    next: { type: 'string' },
                    appOrigin: {
                      type: 'string',
                      description:
                        'The link host of the app asking (an origin such as ' +
                        '`https://app1.example.test`), so the link in the ' +
                        'e-mail opens that app and names this server in ' +
                        '`server`. Must be one of the apps this server is ' +
                        'configured to sign in; any other value is refused ' +
                        'with 400. Absent on the web, where the link stays ' +
                        'on this server.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            202: {
              description: 'The sign-in this client is now waiting on',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sent', 'requestId', 'clientSecret'],
                    properties: {
                      sent: { type: 'boolean' },
                      requestId: { type: 'string' },
                      clientSecret: {
                        type: 'string',
                        description:
                          'Held by this client, so a link opened elsewhere ' +
                          'can finish the sign-in it is waiting on'
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            404: errorResponse,
            429: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}': {
        get: {
          summary: 'Who can see this, and how',
          description:
            'The page behind the gear on a team, season or league card. ' +
            '`tree` names the levels around this one, so a tick in the ' +
            'people table can say which season or league it stands for. ' +
            'Answers 404 to anybody who does not administer the scope.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          responses: {
            200: {
              description: 'The people, the pending invitations and the links',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ManagePage' }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/league/{leagueId}/safesport': {
        put: {
          summary: 'Say whether a league is a SafeSport LAO',
          description:
            'For the league’s own administrators and site admins; anybody ' +
            'else, a season admin included, gets 404. `{lao: true}` marks the ' +
            'league as a SafeSport Local Affiliated Organization, which binds ' +
            'it to the MAAPP. Audited. Answers `{leagueId, safesportLao}`.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'leagueId',
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
                  type: 'object',
                  required: ['lao'],
                  properties: { lao: { type: 'boolean' } }
                }
              }
            }
          },
          responses: {
            200: { description: '`{leagueId, safesportLao}`' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/field': {
        put: {
          summary: "Set or clear a league's or season's fence distance",
          description:
            'Whole feet, 1 to 600, from home plate to the fence on this ' +
            "league's or season's fields. A game takes its own, else its " +
            "season's, else its league's, else 200. `null` clears this " +
            "level's. A team has no field of its own: `team` answers 400. " +
            'Answers 404 to anybody who does not administer the scope.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: fenceDistanceBody
              }
            }
          },
          responses: {
            200: {
              description: 'What the level holds now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['scopeType', 'scopeId', 'fenceDistanceFt'],
                    properties: {
                      scopeType: {
                        type: 'string',
                        enum: ['league', 'season']
                      },
                      scopeId: { type: 'string' },
                      fenceDistanceFt
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people': {
        post: {
          summary: 'Add one person by address',
          description:
            'An address an account has verified adds that account at once, ' +
            'as a member of this level with the roles asked for, Admin ' +
            'included: `added` true and `person` (`added` false when they ' +
            'held all of it already). They are told in their inbox, with a ' +
            'way to leave, and mailed at the address; a failed mail undoes ' +
            'the add (500), so a retry adds and mails again. An address ' +
            'nobody has verified gets a seven-day invitation (`invited`), ' +
            'applied when somebody signs in with it or verifies it, or ' +
            'accepted from its link. Inviting creates no account. A pending ' +
            'replacement does not count as an active direct administrator. ' +
            'Only an administrator of the level may call; anybody else gets ' +
            '404.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    admin: { type: 'boolean', default: false },
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
                      },
                      default: []
                    },
                    idempotencyKey: {
                      type: 'string',
                      minLength: 8,
                      maxLength: 120,
                      description:
                        'Stable retry key; omitted by legacy clients.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description:
                'Added at once (`person`), or invited by address (`invited`)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['added'],
                    properties: {
                      added: { type: 'boolean' },
                      person: {
                        type: 'object',
                        properties: {
                          userId: userIdSchema,
                          displayName: { type: 'string' },
                          email: { type: 'string' }
                        }
                      },
                      invited: {
                        $ref: '#/components/schemas/PendingPerson'
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}': {
        delete: {
          summary: 'Take away what this level grants',
          description:
            'Only this level. A team administrator cannot remove the season ' +
            'membership that also lets somebody watch, which is not theirs ' +
            'and would drop that person from every other team in it.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          responses: {
            200: {
              description: 'Whether there was anything here to remove',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['removed'],
                    properties: { removed: { type: 'boolean' } }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}/roles': {
        put: {
          summary: 'Set everything somebody may do at this level',
          description:
            'Replaces their roles on this one level: `admin`, and any of ' +
            'the flags `coach`, `assistant`, `scorekeeper`, `songkeeper` and ' +
            '`videographer`. A role set here reaches everything inside ' +
            'this level. Only at the level named: a team page sets team ' +
            'roles and nothing wider. It adds them to the level as well, so ' +
            'they can see what they hold a role on, at once, and tells them ' +
            'of what is new. Its administrators, coaches and assistants (set ' +
            'here or on a level above) may call; changing `admin` is for an ' +
            'administrator (403), and anybody else gets 404, as does somebody ' +
            'not on the level\u2019s people list. Nobody may clear their own ' +
            '`admin` here.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['admin', 'flags'],
                  properties: {
                    admin: { type: 'boolean' },
                    flags: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/RoleFlag' }
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'The roles they hold on this level now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'roles'],
                    properties: {
                      userId: userIdSchema,
                      roles: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Role' }
                      }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/manage/{scopeType}/{scopeId}/people/{userId}/roles/{role}': {
        put: {
          summary: 'Give one role at this level, or its membership, at once',
          description:
            '`role` is `admin`, a flag, or `member`. A role brings the ' +
            'level\u2019s membership with it. Nothing waits for acceptance: ' +
            'the person is told in their inbox, and mailed when they were ' +
            'not in the level before. Its administrators, coaches and ' +
            'assistants may call; `admin` is for an administrator (403). ' +
            'Anybody else, and anybody not on the level\u2019s people list, ' +
            'gets 404. A role needs an account that signs in (409).',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam, roleParam],
          responses: {
            200: heldAtResponse,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        },
        delete: {
          summary: 'Take one role at this level away, or take them out of it',
          description:
            'A role, or with `member` the level\u2019s membership and every ' +
            'role there. What a level above gives stays. Taking away ' +
            '`admin`, or taking an administrator out, is for an ' +
            'administrator (403), and the last direct administrator stays ' +
            '(409). A player of a team is not taken out of it this way ' +
            '(409): their membership is their place on its roster.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam, roleParam],
          responses: {
            200: heldAtResponse,
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/me/groups/{kind}/{id}': {
        delete: {
          summary: 'Leave a team, season or league',
          description:
            'Takes away your membership of it and every role you hold ' +
            'there. What a level above gives you is left there, to leave ' +
            'at that level. The last direct administrator stays (409).',
          security: [{ bearer: [] }],
          parameters: [kindParam, idParam],
          responses: {
            200: {
              description: 'Whether there was anything to leave',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['removed'],
                    properties: { removed: { type: 'boolean' } }
                  }
                }
              }
            },
            401: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/me/groups/{kind}/{id}/roles/{role}': {
        delete: {
          summary: 'Step down from one of your roles at a level',
          description:
            'Keeps the level\u2019s membership and your other roles. A role ' +
            'you do not hold there changes nothing. The last direct ' +
            'administrator stays (409).',
          security: [{ bearer: [] }],
          parameters: [kindParam, idParam, roleOnlyParam],
          responses: {
            200: heldAtResponse,
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      ...Object.fromEntries(
        (['seasons', 'leagues'] as const).map(collection => [
          `/${collection}/{id}/people`,
          {
            get: {
              summary: `A ${collection.slice(0, -1)}\u2019s people, in the roster\u2019s sections`,
              description:
                'Admins and Staff: roles given here and on the league ' +
                'above. Players: everybody playing now on a team this ' +
                'level reaches, with `teamNames`. Family members: their ' +
                'guardians. Spectators: members here and of the league ' +
                'above. Followers: people following this level. Each ' +
                'person once, in the first that fits, with a pill for a ' +
                'level above. For its members and role holders and site ' +
                'administrators; anybody else gets 404. `manages` and ' +
                '`admin` say what this viewer may do with them.',
              security: [{ bearer: [] }],
              parameters: [idParam],
              responses: {
                200: {
                  description: 'The people, and what this viewer may do',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['people', 'manages', 'admin'],
                        properties: {
                          people: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/RosterEntry' }
                          },
                          manages: { type: 'boolean' },
                          admin: { type: 'boolean' }
                        }
                      }
                    }
                  }
                },
                401: errorResponse,
                404: errorResponse
              }
            }
          }
        ])
      ),
      ...Object.fromEntries(
        (['teams', 'seasons', 'leagues'] as const).map(collection => [
          `/${collection}/{id}/people/{userId}`,
          {
            get: {
              summary: `One person, as a ${collection.slice(0, -1)} sees them`,
              description:
                'For the level\u2019s administrators, coaches and assistants, ' +
                'and the person themselves; anybody else gets 404, as does ' +
                'somebody not on the level\u2019s people list.',
              security: [{ bearer: [] }],
              parameters: [idParam, userIdParam],
              responses: {
                200: {
                  description: 'The profile',
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/PersonProfile' }
                    }
                  }
                },
                401: errorResponse,
                404: errorResponse
              }
            }
          }
        ])
      ),
      '/manage/{scopeType}/{scopeId}/people/{userId}/role': {
        put: {
          summary: 'Make somebody an administrator of this level, or not',
          description:
            'The route from before the role flags, kept for older apps. ' +
            '`admin` makes them this level\u2019s administrator and `member` ' +
            'takes that away; either leaves their flags as they were, and ' +
            'leaves them able to watch. Only at the level named. Nobody may ' +
            'demote themselves.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam, userIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['role'],
                  properties: {
                    role: { type: 'string', enum: ['admin', 'member'] }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'What they are now',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['userId', 'role'],
                    properties: {
                      userId: userIdSchema,
                      role: { type: 'string', enum: ['admin', 'member'] }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/live': {
        get: {
          summary: 'The games being played right now that you may watch',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description:
                'Newest first, and empty on every day when nothing is on'
            },
            401: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams': {
        get: {
          summary: 'Every camera pointed at this game',
          description:
            'Split into `mine` and `others`. A key is a person\u2019s: their own ' +
            'cameras come back whole enough to act on, and everybody ' +
            'else\u2019s are named — whose, what it is called, what it is doing ' +
            '— and never carry a key.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: 'Mine, theirs, and how many more I may add',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            404: errorResponse
          }
        },
        post: {
          summary: 'Another camera of my own on this game',
          description:
            'Up to four per person per game. The slot is the lowest I do not ' +
            'already hold, so ending one and asking again gives that number ' +
            'back rather than counting upwards.\n\n' +
            'With `deviceId`, the stream that device holds under that camera ' +
            'name: the same one again, in any case (200); else one an ' +
            'installed TS Director claimed under that name, which the device ' +
            'adopts with its key and video (200); else a new one (201), after ' +
            'revoking an ended stream of that device and name. A camera name ' +
            'is unique among my active device streams on the game (409). A ' +
            'redial sends `heldStreamId`; if that stream was ended or ' +
            'revoked the answer is 410 and nothing is created.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    deviceId: {
                      type: 'string',
                      description: 'The install id of the device asking'
                    },
                    deviceModel: { type: 'string', maxLength: 60 },
                    recordsLocally: {
                      type: 'boolean',
                      description:
                        'A phone keeps its own recording: only its own ' +
                        'upload replaces this stream\u2019s live copy'
                    },
                    heldStreamId: {
                      type: 'string',
                      description:
                        'The stream a redial already holds. Only an explicit ' +
                        'start leaves it out'
                    }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Created, with the URL and its key',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            200: {
              description:
                'The stream this device already holds or adopted, or the ' +
                'one that won a race for the same slot'
            },
            400: errorResponse,
            404: errorResponse,
            409: errorResponse,
            410: errorResponse
          }
        }
      },
      '/videos/{videoId}/wall-timeline': {
        get: {
          summary: "Where each moment of a video falls on the server's clock",
          description:
            '`{ anchors, source, confidence, live, startAt }`. `anchors` are ' +
            '`[mediaMs, wallMs]` pairs in media order: `mediaMs` is a ' +
            "position as a player's `currentTime` reports it, `wallMs` the " +
            'server-clock instant (epoch ms) of the frame there. A position ' +
            'falls at the last anchor at or before it, plus the media time ' +
            'since, at 1×. `source` is `sei` (a wall clock in every frame), ' +
            '`arrival` (when the server took each live segment in; any such ' +
            'anchor makes the whole video `arrival`) or `start` (no anchors ' +
            'stored: one at media time zero from `startAt` less the ' +
            "video's sync offset, none without a `startAt`). `confidence` " +
            'is `frame` for `sei` stamped on the server clock throughout, ' +
            '`clock` for a start moved onto the server clock by a measured ' +
            'offset, and `approximate` for everything else. `live` is true ' +
            'while the video is still streaming and more anchors may come. ' +
            '404 for no such video or a hidden one; 403 `membersOnly` for ' +
            'somebody who cannot see its game.',
          security: [{ bearer: [] }],
          parameters: [
            videoIdParam,
            {
              name: 'afterMs',
              in: 'query',
              schema: { type: 'integer', minimum: 0, maximum: 2147483647 },
              description:
                'Only the anchors after this media time, for a live player ' +
                'that holds the rest. `source` and `confidence` still ' +
                'describe the whole video. Omitted, every anchor.'
            }
          ],
          responses: {
            200: {
              description: '`{ anchors, source, confidence, live, startAt }`'
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse
          }
        }
      },
      '/videos/{videoId}': {
        delete: {
          summary: 'Delete a recording, its files, and its copy in the Space',
          description:
            'For whoever runs the game, and for the person whose camera made ' +
            'it. Refused while something is still streaming into it, and ' +
            'refused for a legacy recording, which lives in a tree this ' +
            'server reads and does not own.',
          security: [{ bearer: [] }],
          parameters: [videoIdParam],
          responses: {
            200: {
              description: 'What went, and how much of it left the Space',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      removedFromSpace: { type: 'integer' }
                    }
                  }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}': {
        delete: {
          summary: 'Take one of my cameras off this game',
          description:
            'Not the same as ending it. Ending stops a camera; this removes ' +
            'it and gives its number back. Mine only, and refused while it ' +
            'is streaming. An empty recording goes with it; one that holds ' +
            'video stays, and is deleted on its own.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: {
              description: 'What is left pointed at this game',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LiveStream' }
                }
              }
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        },
        patch: {
          summary:
            'Rename one of my cameras, or say a phone holds its recording',
          description:
            'A device stream\u2019s new name must not be one of my other ' +
            'active device streams\u2019 on the game (409). ' +
            '`localRecording` takes only `recorded`, and only on a device ' +
            'stream; the first change from `none` records an upload reminder ' +
            'for me. `liveStartedAt` says when the stream\u2019s first picture ' +
            'was captured, on the server\u2019s clock (`GET /time`): the live ' +
            'video is placed there unless a publisher already placed it, or ' +
            'the instant is too far from when the publish arrived to be of it.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    localRecording: { type: 'string', enum: ['recorded'] },
                    liveStartedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'The camera as it now stands' },
            400: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/reveal': {
        post: {
          summary: 'Show one of my URLs again, key and all',
          description:
            'Mine only — somebody else\u2019s key is answered 404, because it ' +
            'publishes video as them. Written to the audit log every time.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, with its URL' },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/rotate': {
        post: {
          summary: 'Replace one of my keys. The old one stops at once',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, with its new URL' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/live-streams/{streamId}/end': {
        post: {
          summary: 'End one camera now',
          description:
            'Mine, or anybody\u2019s if I run the team: a stream on their game ' +
            'that should not be there is theirs to stop. Closes the window ' +
            'rather than the playlist — only the ingest may touch a file its ' +
            'own ffmpeg is writing, and it notices within the second.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          responses: {
            200: { description: 'The camera, ending' },
            404: errorResponse
          }
        }
      },
      '/events': {
        post: createEventOperation(errorResponse),
        get: {
          summary: 'Games and team events, filtered by the query string',
          description:
            'The one list. `scope=visible` (the default) is every game you ' +
            'may see: your teams, and every game of a season opened to you. ' +
            'A site administrator sees every game. `scope=run` is every game ' +
            'you may score — owner, manager, or an admin of the team, its ' +
            'season or its league — and omits cancelled games. Somebody who ' +
            'runs nothing gets an empty array. `scope=film` is every game ' +
            'you may film — a videographer of the team, its season or its ' +
            'league, which every admin of them is — and omits cancelled ' +
            'games. Somebody who films nothing gets an empty array.\n\n' +
            '`season` may be repeated. On `scope=visible`, a season you ' +
            'cannot see is 404. `when` is `all` (newest first), `upcoming` ' +
            '(no score and still ahead, soonest first), `past` (the rest), ' +
            '`future` (still ahead, scored or not, soonest first), ' +
            '`finished` (started before the look-back, latest first), or ' +
            '`recent` (started inside the look-back, up to now, latest ' +
            'first). `lookbackHours` is how far `finished` (default 2), ' +
            '`recent` (default 3), and `when=all` reach; on `when=all` the ' +
            'list runs forward from that instant. `since` and `until` are ' +
            'instants, `until` exclusive. `order` is `asc` or `desc`. ' +
            '`limit` is a whole number of at least 1; omit it for no cap. ' +
            '`externalId` may be repeated. `played=1` keeps games that have ' +
            'a score. `scoreboard=open` keeps games whose scoreboard is ' +
            'still open, and answers 503 while that store is away. ' +
            '`hasVideo=1` keeps games with a video that is not hidden.\n\n' +
            '`paged=1` answers `{items, nextCursor, prevCursor, anchorId, ' +
            'counts}` rather than the bare array, `limit` rows at a time ' +
            '(50 by default, 100 at most), and does not take ' +
            '`scoreboard=open`. `nextCursor` is null at the end, and ' +
            '`prevCursor` is set on any page with rows before it; send either ' +
            'back as `cursor` with the same query to read on. A first page ' +
            'has `counts`: `total`, `upcoming`, `withVideo`, `videos` and ' +
            '`newestSeasonId`, for the whole list leaving out `when` and ' +
            '`hasVideo`. `around=next` opens a first page on the row the app ' +
            'opens a schedule on, named by `anchorId`, with `limit / 2` rows ' +
            'before it and `limit` from it, in `asc` order, and its cursors ' +
            'read on with `order=asc`.\n\n' +
            'Pending schedules carry exhibition/timezone and pendingApproval, with pendingRequestId only for an actor authorized to read the request. Existing revisions retain approved fields, canceled originals remain canceled, and new proposals have a reserved event ID with no scoring access. Scope run/film and scoreboard=open omit unpublished proposals. No private request terms are returned. ' +
            'Each row is a schedule game plus `gameId`, both teams\u2019 logo ' +
            'URLs, `liveState`, and `opponentFixed`: true when a schedule ' +
            "can never change the game's opponent, because it was scored in " +
            'TeamStation (scored by its scorer, a play carrying its ' +
            '`teamStation` record, or an at-bat under way) or neither team ' +
            'is a placeholder.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'scope',
              in: 'query',
              schema: { type: 'string', enum: ['visible', 'run', 'film'] }
            },
            {
              name: 'season',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true
            },
            {
              name: 'when',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'all',
                  'upcoming',
                  'past',
                  'future',
                  'finished',
                  'recent'
                ]
              }
            },
            {
              name: 'lookbackHours',
              in: 'query',
              schema: { type: 'number' }
            },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'string', format: 'date-time' }
            },
            {
              name: 'until',
              in: 'query',
              schema: { type: 'string', format: 'date-time' }
            },
            {
              name: 'order',
              in: 'query',
              schema: { type: 'string', enum: ['asc', 'desc'] }
            },
            {
              name: 'limit',
              in: 'query',
              description:
                'No cap by default. With `paged`, 50 by default and 100 at most.',
              schema: { type: 'integer', minimum: 1 }
            },
            {
              name: 'externalId',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              style: 'form',
              explode: true
            },
            {
              name: 'played',
              in: 'query',
              schema: { type: 'string', enum: ['1', 'true'] }
            },
            {
              name: 'scoreboard',
              in: 'query',
              schema: { type: 'string', enum: ['open'] }
            },
            ...schedulePageParams
          ],
          responses: {
            200: { description: 'The games that match' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}': {
        get: {
          summary: "A game's scoreboard, as it is drawn",
          description:
            'No sign-in. `{ state }`, the board with every override applied, ' +
            "while the scoreboard is open: from the game's creation until two " +
            'hours after its start, and after that until two hours after the ' +
            'last write, never later than three days after the start. 404 ' +
            'for a cancelled or unknown game or a closed scoreboard, and 503 ' +
            'while the scoreboard store is unreachable.',
          parameters: [gameIdParam],
          responses: {
            200: { description: '`{ state }`' },
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}/dashboard': {
        get: {
          summary: "The override dashboard's state, or its socket",
          description:
            'As JSON: `{ automated, overrides, final, gameAt, watcherAt }`, ' +
            'where `gameAt` and `watcherAt` are when (epoch ms) each ' +
            'automated source last reported a contested field. ' +
            'With `Upgrade: websocket` it is the dashboard socket: it sends ' +
            "`{ type: 'state', automated, overrides, final, gameAt, " +
            'watcherAt }` on open and after every change, and takes ' +
            "`{ type: 'overrides', data }`, stored whole, or " +
            "`{ type: 'reset' }`, which clears every override and TS " +
            "Watcher's stored state, so the board shows the game's own " +
            'scoring. An unreadable message is answered with ' +
            '`{ error }` and the socket stays open. **Who may call:** a site ' +
            'admin or an admin of either team; anybody else gets 404, or ' +
            'close 4403 on the socket. Socket close codes: 4401 not signed ' +
            'in, 4403 may not override this game, 4404 no such game or its ' +
            'scoreboard is closed, 1011 the store is unreachable.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            101: { description: 'The dashboard socket' },
            200: { description: 'The dashboard state' },
            401: errorResponse,
            404: errorResponse,
            503: errorResponse
          }
        }
      },
      '/scoreboard/{gameId}/socket': {
        get: {
          summary: "A game's scoreboard as a WebSocket",
          description:
            'No sign-in. Sends the board as it is drawn, `ScoreState` JSON, ' +
            'on open and after every change from any source. Inbound ' +
            'messages are ignored. Closes with 4404 when there is no such ' +
            'game or its scoreboard is closed, and 1011 while the store is ' +
            'unreachable. With `timeline=1` it sends no boards: it sends ' +
            "`{ type: 'changed' }` each time the game's board timeline " +
            '(`GET /games/{gameId}/scoreboard-timeline`) changes, once the ' +
            'change has been stored, and it stays open for as long as the ' +
            'game exists, whether or not its scoreboard is open. **Who may ' +
            'call with `timeline=1`:** what the timeline asks, somebody ' +
            'signed in, by bearer token or session cookie, who can see the ' +
            'game; asked again every minute while it is open. Its close ' +
            'codes add 4401 not signed in and 4403 cannot see the game.',
          parameters: [
            gameIdParam,
            {
              name: 'timeline',
              in: 'query',
              schema: { type: 'string', enum: ['1'] },
              description:
                '`1` for change notices instead of boards, for somebody ' +
                'signed in who can see the game. Omitted, the socket sends ' +
                'the board as before, to anybody.'
            }
          ],
          responses: { 101: { description: 'The viewer socket' } }
        }
      },
      '/scoreboard/{gameId}/publish': {
        get: {
          summary: "Publish to a game's scoreboard over a WebSocket",
          description:
            "TS Watcher's socket. Each message is a bare partial " +
            '`ScoreState` JSON object, merged into what Watcher has sent ' +
            'before. Team names are ignored: they come from the game. An ' +
            'unreadable message is answered with `{ error }` and the socket ' +
            'stays open. **Who may call:** a site admin or an admin of ' +
            'either team, by bearer token or session cookie. Close codes: ' +
            '4401 not signed in, 4403 may not publish this game, 4404 no ' +
            'such game or its scoreboard is closed, 1011 the store is ' +
            'unreachable.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: { 101: { description: 'The publisher socket' } }
        }
      },
      '/director/events/{gameId}/claim': {
        post: {
          summary: 'Take a game, and get the URL to publish it to',
          description:
            'For a videographer of either team, which every admin of it ' +
            'is. Anybody else gets 404. Kept for the TS Director builds ' +
            'already installed: it returns my lowest-numbered stream that no ' +
            'device holds, renamed to `cameraName`, or makes one in my lowest ' +
            'free slot, and never returns or renames a device\u2019s stream. ' +
            'Newer builds ask `POST /games/{gameId}/live-streams` with their ' +
            'install id.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description:
                'The URL with its key, which the operator never sees or types'
            },
            400: errorResponse,
            404: errorResponse
          }
        }
      },
      '/director/uploads': {
        post: {
          summary: 'Open an upload of a finished recording',
          description:
            'TS Director and TS Distributor send a take in parts, so an ' +
            'upload cut off half way carries on rather than starting again. ' +
            'For a videographer of either team of the game, which every ' +
            'admin of it is; anybody else gets 404. 400 when the server has ' +
            'nowhere to put a recording, or the recording is empty. The ' +
            'answer says how big each part is and how many to send. An ' +
            'upload with no `liveStreamId` replaces the live copies it ' +
            'covers by the 120-second coverage rule, among streams that do ' +
            'not keep their own recording. `liveStreamId` counts only for a ' +
            'stream of mine on this game that keeps its own recording and ' +
            'has not been replaced, ended or revoked streams included. That ' +
            'stream\u2019s live copy alone is replaced when the upload lands: ' +
            'always with `wholeStream`, else only if the upload covers it, ' +
            'and never while it is publishing; a stream with no live copy is ' +
            'settled by the upload all the same. Any other stream of mine ' +
            'makes the upload replace nothing. 409 when it is publishing as ' +
            'the upload opens.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['gameId', 'title', 'filename', 'sizeBytes'],
                  properties: {
                    gameId: { type: 'string' },
                    title: { type: 'string' },
                    kind: {
                      type: 'string',
                      description:
                        '`program` (the default) for the programme output, ' +
                        "or the camera's own name"
                    },
                    filename: { type: 'string' },
                    sizeBytes: { type: 'integer', minimum: 1 },
                    startAt: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        "When the recording began, on the app's clock. The " +
                        'video starts here. Left out, or more than a year ' +
                        "from now, the game's own start is used instead"
                    },
                    serverClockOffsetMs: {
                      type: 'integer',
                      description:
                        "The server's clock less the app's while it " +
                        'recorded, in ms, as the app measured it from ' +
                        '`GET /time`. Added to `startAt`, so the video ' +
                        "starts on the server's clock and its wall " +
                        'timeline says `clock`. Left out, `startAt` is used ' +
                        'as it is. A value that is not finite or is more ' +
                        'than a day either way is ignored, and the upload ' +
                        'goes in as one without it'
                    },
                    liveStreamId: {
                      type: 'string',
                      description:
                        'The phone stream this recording was made alongside'
                    },
                    wholeStream: {
                      type: 'boolean',
                      description:
                        'The recording ran for every moment that stream ' +
                        'published, so its live copy is replaced whatever ' +
                        'the coverage test says'
                    }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: '`{ uploadId, partSize, parts, received: [] }`'
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            409: errorResponse
          }
        }
      },
      '/director/uploads/{uploadId}': {
        get: {
          summary: 'What of an upload has arrived, and what is left',
          description:
            '`{ uploadId, state, step, partSize, parts, received, missing, ' +
            'receivedBytes, videoId, message }`. `state` is `open`, ' +
            '`assembling` (with `step` saying which part of taking it in), ' +
            '`ready` (with `videoId`), `failed` (with `message`) or ' +
            '`abandoned`. Somebody else’s upload is 404.',
          security: [{ bearer: [] }],
          parameters: [uploadIdParam],
          responses: {
            200: { description: 'The upload as it stands' },
            401: errorResponse,
            404: errorResponse
          }
        },
        delete: {
          summary: 'Give an upload up, and its parts with it',
          security: [{ bearer: [] }],
          parameters: [uploadIdParam],
          responses: {
            204: { description: 'Abandoned' },
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/director/uploads/{uploadId}/parts/{index}': {
        put: {
          summary: 'One part of an upload',
          description:
            'The raw bytes of part `index`, counting from zero, exactly as ' +
            'long as the open said. Sending a part again replaces it. 400 ' +
            'for a part of the wrong length or not in the recording, and ' +
            'once the upload is past taking parts.',
          security: [{ bearer: [] }],
          parameters: [
            uploadIdParam,
            {
              name: 'index',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 0 }
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          responses: {
            200: { description: '`{ received, parts, missing }`' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/director/uploads/{uploadId}/finish': {
        post: {
          summary: 'Make a complete upload a video',
          description:
            'Answered at once with 202 `{ state: "assembling" }` while the ' +
            'parts are joined, remuxed and copied to the Space; `GET ' +
            '/director/uploads/{uploadId}` says when it is `ready` and its ' +
            '`videoId`. The video starts at the open’s `startAt` plus its ' +
            '`serverClockOffsetMs`, less any pre-roll the file holds. The ' +
            'live recording of the game it replaces is hidden. Asked again ' +
            'once ready, the same `videoId`; a failed upload can be asked ' +
            'again. 400 while parts are missing.',
          security: [{ bearer: [] }],
          parameters: [uploadIdParam],
          responses: {
            200: { description: '`{ videoId, state: "ready" }`, already done' },
            202: { description: '`{ state: "assembling", step }`' },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse
          }
        }
      },
      '/auth/link/verify': {
        post: {
          summary: 'Spend the link from the e-mail',
          description:
            'Never reached by a bare page load: the address opens the app, ' +
            'which asks for this once it is running, so a mail scanner that ' +
            'follows links without running scripts cannot spend it.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: {
                    token: { type: 'string' },
                    deviceName: {
                      type: 'string',
                      description:
                        'Set by a device spending its own link: the session ' +
                        'is named for it and lasts 180 days, as a device ' +
                        'session from a typed code does'
                    },
                    requestId: {
                      type: 'string',
                      description:
                        'The sign-in request the spender is itself polling ' +
                        'for. When it is this link’s, the poll is not ' +
                        'approved as well, so the spender gets one session'
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'A session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            401: errorResponse
          }
        }
      },
      '/auth/request/claim': {
        post: {
          summary: 'What the client that asked for the sign-in is waiting on',
          description:
            'Tap the link on a laptop while TS Director is still waiting, and ' +
            'this is how the iPad finds out: it polls with a secret only it ' +
            'holds. `deviceName` asks for a session that lasts a season and ' +
            'is named, which is what a Director wants and a browser does not.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['requestId', 'clientSecret'],
                  properties: {
                    requestId: { type: 'string' },
                    clientSecret: { type: 'string' },
                    deviceName: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'A session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Session' }
                }
              }
            },
            202: { description: 'Still waiting, which is the ordinary answer' },
            401: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/stats': {
        get: {
          summary: 'Authorized season batting and pitching aggregates',
          description:
            'Requires private season access. Adds only stored stat rows from visible games assigned to this season. Names are shortened. Public discovery never receives this resource.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            200: {
              description:
                'Season aggregates using the same rate calculations as team stats.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SeasonStats' }
                }
              }
            },
            404: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/standings': {
        get: {
          summary: "A season's table",
          description:
            'For anybody in the season or a season or league that opened ' +
            'itself to them, and for anybody else signed in once a team is ' +
            'active in it (each team page shows its place); a season with ' +
            'no active team answers them 404.',
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            },
            {
              name: 'includeExhibitions',
              in: 'query',
              schema: { type: 'boolean', default: true },
              description:
                'False excludes exhibitions. Omission preserves inclusion of every season game.'
            }
          ],
          responses: {
            200: {
              description:
                'StandingsRow array: teamId/teamName/teamKind/logoUrl, w/l/t, played, winningPct (ties count half), gamesBehind, runsFor/runsAgainst/runDifferential, streak, home/away {w,l,t}. Zero results have null percentage, GB and streak. Sort by percentage, differential, name and ID.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/StandingsRow' }
                  }
                }
              }
            },
            400: errorResponse,
            404: errorResponse
          }
        }
      }
    }
  }
}
