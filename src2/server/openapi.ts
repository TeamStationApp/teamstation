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
          summary: "A game's batting lines",
          description: 'Worked out from the stored plays.',
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
          summary: "A player's batting by season, and their career",
          description:
            'A career is the sum of the season rows, so a player on two teams ' +
            'in one season keeps them apart. Runs scored, stolen bases and ' +
            'caught stealing are not reported: they need runner movement from ' +
            'the game stream, and a figure that cannot be derived honestly is ' +
            'left out rather than guessed.',
          security: [{ bearer: [] }],
          parameters: [userIdParam],
          responses: {
            200: { description: 'Season lines and the career total' },
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
