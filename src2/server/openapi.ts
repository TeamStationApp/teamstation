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
      }
    }
  }
}
