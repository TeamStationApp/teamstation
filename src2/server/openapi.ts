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

const gameIdParam = {
  name: 'gameId',
  in: 'path',
  required: true,
  schema: { type: 'string' }
}

const streamIdParam = {
  name: 'streamId',
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
  schema: { type: 'string' }
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
/** Anything with an id and a name, which is how the tree is drawn. */
const namedThing = {
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } }
}

export function openApiDocument(version: string): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'GameStation',
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
                'tooLarge',
                'unsupportedMedia',
                'rateLimited',
                'internal'
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
            pid: { type: 'integer' }
          }
        },
        User: {
          type: 'object',
          required: ['id', 'displayName', 'isAdmin'],
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            email: { type: ['string', 'null'] },
            isAdmin: { type: 'boolean' }
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
            userId: { type: 'string' },
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
            adminOf: {
              type: 'array',
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
        ScopeGrant: {
          type: 'object',
          required: ['id', 'name', 'role'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' }
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
            invitedAt: { type: 'string', format: 'date-time' }
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
                name: { type: 'string' }
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
      '/auth/password': {
        post: {
          summary: 'Sign in with an e-mail address and a password',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string' },
                    password: { type: 'string' }
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
            'so this cannot be used to find out who is registered.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string' } }
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
      '/auth/me': {
        get: {
          summary: 'Who this token belongs to',
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
          summary: 'The teams this person belongs to',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'Their teams, which may be an empty list' },
            401: errorResponse
          }
        }
      },
      '/teams/{teamId}/games': {
        get: {
          summary: "A team's games, newest first",
          description:
            'Answers 404 rather than 403 for a team the caller may not see, ' +
            'so that probing cannot reveal which teams exist.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'Games, newest first, with a video count' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}': {
        get: {
          summary: 'One game and its videos',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: { description: 'The game, its score and its videos' },
            404: errorResponse
          }
        }
      },
      '/games/{gameId}/box-score': {
        get: {
          summary: "A game's batting and pitching lines",
          description:
            'Added up from the stored stat lines, one row per player per ' +
            'game, counted by walking the archived game stream. Earned runs ' +
            'are included, which a play-by-play cannot produce.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          responses: {
            200: {
              description: 'A line per batter, with rates worked out on read'
            },
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
            'timestamp into the full video, never a separate clip. When the ' +
            "game's plays did not add up to its imported line score, " +
            '`withheld` is `scoreMismatch` and the list is empty.',
          security: [{ bearer: [] }],
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
      '/players/{userId}/stats': {
        get: {
          summary: "A player's batting and pitching, narrowed as asked",
          description:
            'Every figure is a sum of that player\u2019s per-game stat lines, ' +
            'so a total here and a line in a box score are the same rows ' +
            'added up differently. Unfiltered is a career. The answer carries ' +
            'the seasons, teams and years there are to choose from, which is ' +
            'what the filter on the page offers. `rates.era` is absent until ' +
            "something has worked out the league's regulation length: an ERA " +
            'is earned runs per game.',
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
        get: {
          summary: 'The seasons you may watch',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description:
                'Being in a season grants every team in it; being on a team ' +
                'is separate and stronger'
            },
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
            200: { description: 'Every team playing in it' },
            404: errorResponse
          }
        }
      },
      '/seasons/{seasonId}/games': {
        get: {
          summary: "A season's schedule",
          security: [{ bearer: [] }],
          parameters: [
            {
              name: 'seasonId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            },
            {
              name: 'when',
              in: 'query',
              schema: { type: 'string', enum: ['past', 'upcoming'] },
              description: 'Which half of the schedule. Both, when unset'
            }
          ],
          responses: {
            200: { description: 'Newest first' },
            404: errorResponse
          }
        }
      },
      '/games/recent': {
        get: {
          summary: 'The newest played game anywhere you can see',
          description:
            'What the home screen leads with. Null when there is none.',
          security: [{ bearer: [] }],
          responses: {
            200: { description: 'One game, or null' },
            401: errorResponse
          }
        }
      },
      '/teams/{teamId}/roster': {
        get: {
          summary: "A team's players, coaches and followers",
          description:
            'Names are a first name and a last initial: a full name is not ' +
            'something this API hands out about a child.',
          security: [{ bearer: [] }],
          parameters: [teamIdParam],
          responses: {
            200: { description: 'The roster, coaches first' },
            404: errorResponse
          }
        }
      },
      '/teams/{teamId}/stats': {
        get: {
          summary: "A team's batting",
          security: [{ bearer: [] }],
          parameters: [
            teamIdParam,
            {
              name: 'seasonId',
              in: 'query',
              schema: { type: 'string' },
              description: 'One season, or every season when unset'
            }
          ],
          responses: {
            200: { description: 'A row per player' },
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
            'that a connection closed.',
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
                      enum: ['web', 'ios', 'android']
                    },
                    next: { type: 'string' }
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
      '/manage/{scopeType}/{scopeId}/people': {
        post: {
          summary: 'Add one person by address',
          description:
            'An address that already has an account is given the access at ' +
            'once. Any other is sent an invitation made out to it, good for ' +
            'one use; the account is still made by the sign-in that follows.',
          security: [{ bearer: [] }],
          parameters: [scopeTypeParam, scopeIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string' } }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Added, or invited',
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
                          userId: { type: 'string' },
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
      '/manage/{scopeType}/{scopeId}/people/{userId}/role': {
        put: {
          summary: 'Make somebody an administrator of this level, or a member',
          description:
            'Only at the level named: a team page makes team administrators ' +
            'and nothing wider. Either answer leaves them able to watch, ' +
            'because an administrator of something they cannot see is a ' +
            'state nobody asks for on purpose. Nobody may demote themselves.',
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
                      userId: { type: 'string' },
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
            'back rather than counting upwards.',
          security: [{ bearer: [] }],
          parameters: [gameIdParam],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { label: { type: 'string' } }
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
            200: { description: 'The one that won a race for the same slot' },
            400: errorResponse,
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
          summary: 'Rename one of my cameras',
          security: [{ bearer: [] }],
          parameters: [gameIdParam, streamIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'The camera as it now stands' },
            400: errorResponse,
            404: errorResponse
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
      '/director/events': {
        get: {
          summary: 'The next ten games of the teams you run',
          description:
            'Soonest first, reaching two hours backwards \u2014 a one o\u2019clock ' +
            'game somebody starts filming at ten past three is still the game ' +
            'they mean.',
          security: [{ bearer: [] }],
          responses: {
            200: {
              description: 'At most ten, each with both teams\u2019 marks'
            },
            401: errorResponse
          }
        }
      },
      '/director/events/{gameId}/claim': {
        post: {
          summary: 'Take a game, and get the URL to publish it to',
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
      '/auth/link/verify': {
        post: {
          summary: 'Spend the link from the e-mail',
          description:
            'Never reached by a bare page load: the address opens the app, ' +
            'which asks for this once it can tell a person is behind the ' +
            'request. A mail scanner follows links and runs no scripts.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: { token: { type: 'string' } }
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
            'Tap the link on a laptop while GS Director is still waiting, and ' +
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
      '/seasons/{seasonId}/standings': {
        get: {
          summary: "A season's table",
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
                'Best record first, run differential as the tie-break'
            },
            404: errorResponse
          }
        }
      }
    }
  }
}
