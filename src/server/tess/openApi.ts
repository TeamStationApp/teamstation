/**
 * Tess's routes in the API document: the caller's conversation with her,
 * their attachments, the changes she proposes, and their weekly usage.
 */

const change = {
  type: 'object',
  required: ['id', 'summary', 'method', 'path', 'body', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    summary: {
      type: 'string',
      description: "Tess's own sentence for what the change does"
    },
    method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
    path: {
      type: 'string',
      description:
        'What the server runs on confirmation, below /api/v1, as stored: show this rather than the summary'
    },
    body: { description: 'The JSON body it runs with, or null' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'done', 'failed', 'expired']
    }
  }
}

const message = {
  type: 'object',
  required: ['id', 'role', 'text', 'attachments', 'changes', 'createdAt'],
  properties: {
    id: { type: 'string' },
    role: { type: 'string', enum: ['user', 'assistant'] },
    text: {
      type: 'string',
      description:
        'Chat Markdown. Tess\'s may hold HTML tables and SVG charts, app links and path links titled "path"'
    },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'kind', 'described'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['image', 'csv', 'text', 'markdown'] },
          described: {
            type: 'boolean',
            description:
              'Its bytes were replaced by a description when the conversation was compacted'
          }
        }
      }
    },
    changes: { type: 'array', items: change },
    createdAt: { type: 'string', format: 'date-time' }
  }
}

const messages = {
  type: 'object',
  required: ['messages'],
  properties: { messages: { type: 'array', items: message } }
}

const json = (schema: unknown): unknown => ({
  'application/json': { schema }
})

export function tessPaths(errorResponse: unknown): Record<string, unknown> {
  const refusals = {
    401: errorResponse,
    403: errorResponse,
    503: errorResponse
  }
  return {
    '/me/tess': {
      get: {
        summary: "The caller's conversation with Tess",
        description:
          'One conversation per person. Tool calls and their results are not ' +
          "shown; Tess's messages of one turn show as one reply, with a card " +
          'for each change she proposed. A machine token gets 403; with no ' +
          'Tess on the server, 503.',
        security: [{ bearer: [] }],
        responses: {
          200: {
            description: 'The conversation and its size in tokens',
            content: json({
              type: 'object',
              required: ['available', 'messages', 'contextTokens'],
              properties: {
                available: { type: 'boolean' },
                messages: { type: 'array', items: message },
                contextTokens: {
                  type: 'integer',
                  description:
                    'The size of the last request; above 150,000 the conversation is compacted'
                }
              }
            })
          },
          ...refusals
        }
      }
    },
    '/me/tess/messages': {
      post: {
        summary: 'Say something to Tess, and get her answer',
        description:
          'Stores the message, expires the changes the caller has not ' +
          'confirmed, and answers once Tess has: the new message and every ' +
          'message after it. `attachmentIds` names up to 5 of the ' +
          "caller's uploads. `screen` is the page beside the chat, sent by a " +
          'wide screen only. A message whose attachments would take the ' +
          'conversation above 200,000 tokens is refused with 413, and ' +
          'neither it nor they are kept. A model failure is 503.',
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string', maxLength: 20000 },
              attachmentIds: {
                type: 'array',
                maxItems: 5,
                items: { type: 'string', format: 'uuid' }
              },
              screen: {
                type: 'object',
                required: ['path', 'title'],
                properties: {
                  path: { type: 'string' },
                  title: { type: 'string' },
                  stack: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['path', 'title'],
                      properties: {
                        path: { type: 'string' },
                        title: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          })
        },
        responses: {
          200: { description: 'The new messages', content: json(messages) },
          400: errorResponse,
          413: errorResponse,
          ...refusals
        }
      }
    },
    '/me/tess/attachments': {
      post: {
        summary: 'Upload a file for a message to Tess',
        description:
          'PNG, JPEG, GIF or WebP pictures up to 5 MB, and CSV, plain text ' +
          'or Markdown up to 1 MB of UTF-8, in base64. With no media type ' +
          'the kind is read from a .csv, .txt or .md name. A picture must be ' +
          'the image it says it is. The body may be up to 8 MB.',
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['name', 'data'],
            properties: {
              name: { type: 'string' },
              mediaType: { type: 'string' },
              data: { type: 'string', contentEncoding: 'base64' }
            }
          })
        },
        responses: {
          201: {
            description: 'The stored file, as a message names it',
            content: json({
              type: 'object',
              required: ['id', 'name', 'kind'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['image', 'csv', 'text', 'markdown']
                }
              }
            })
          },
          400: errorResponse,
          413: errorResponse,
          415: errorResponse,
          ...refusals
        }
      }
    },
    '/me/tess/changes/{changeId}/confirm': {
      post: {
        summary: 'Run a change Tess proposed',
        description:
          'Runs the stored request once, with the caller’s own credentials ' +
          'and permissions, then has Tess report what the server answered. ' +
          "Another person's change is 404; one that is not pending, or has " +
          'expired (30 minutes, or the caller’s next message), is 409, as ' +
          'is a second confirm of the same change.',
        security: [{ bearer: [] }],
        parameters: [
          {
            name: 'changeId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' }
          }
        ],
        responses: {
          200: {
            description: "The change as it ended, and Tess's report",
            content: json({
              type: 'object',
              required: ['change', 'messages'],
              properties: {
                change,
                messages: { type: 'array', items: message }
              }
            })
          },
          404: errorResponse,
          409: errorResponse,
          ...refusals
        }
      }
    },
    '/me/tess/usage': {
      get: {
        summary: "The caller's tokens with Tess, by UTC week",
        description:
          'Weeks start on Monday 00:00 UTC, newest first, up to 12. Input ' +
          'counts fresh, cache-write and cache-read tokens; output is apart. ' +
          'Tracked only: there is no cap.',
        security: [{ bearer: [] }],
        responses: {
          200: {
            description: 'The weeks',
            content: json({
              type: 'object',
              required: ['weeks'],
              properties: {
                weeks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: [
                      'weekStart',
                      'inputTokens',
                      'outputTokens',
                      'requests'
                    ],
                    properties: {
                      weekStart: { type: 'string', format: 'date' },
                      inputTokens: { type: 'integer' },
                      outputTokens: { type: 'integer' },
                      requests: { type: 'integer' }
                    }
                  }
                }
              }
            })
          },
          ...refusals
        }
      }
    }
  }
}
