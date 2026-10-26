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
      enum: ['pending', 'running', 'done', 'failed', 'expired', 'unknown'],
      description:
        'unknown: it began to run and the server gave no answer to it in time, or lost it; whether it happened has to be checked'
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
    createdAt: { type: 'string', format: 'date-time' },
    clientId: {
      type: 'string',
      description: "On a message of the person's, the clientId it was sent with"
    },
    thinking: {
      type: 'string',
      description:
        "On Tess's reply, the summaries of her thinking, joined; absent when she showed none"
    },
    steps: {
      type: 'array',
      description:
        "On Tess's reply, each tool call she made, in order, labelled by the server (never its path or query); absent when she made none",
      items: {
        type: 'object',
        required: ['label', 'status'],
        properties: {
          label: { type: 'string' },
          status: { type: 'string', enum: ['done', 'failed'] }
        }
      }
    }
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

/** A turn streamed, as `Accept: text/event-stream` asks. */
const eventStream = (done: string): unknown => ({
  'text/event-stream': {
    schema: {
      type: 'string',
      description:
        'Server-sent events, each `event: <type>` with its JSON as `data`: ' +
        '`stored` ({messages, change?}) once the message, or the ' +
        'confirmation, is stored; `thinking` and `text` ({delta}), pieces of ' +
        "the summary of her thinking and of her text, a later block's " +
        'starting on a new paragraph; `step` ({id, label, status: ' +
        'running|done|failed}) as each tool call starts and ends; then ' +
        `\`done\` (${done}) or \`error\` ({status, code, message, details?, ` +
        'kept}: the status and body the request would have failed with, ' +
        'and whether the message, or the confirmation, is still stored; ' +
        'one Tess failed to answer before storing anything of her answer is ' +
        'taken back, with its changes pending again). A ' +
        '`: keep-alive` comment comes every 15 seconds. A refusal before ' +
        'the turn begins (400, 401, 403, 404, 409, 413, 415) is answered ' +
        'as JSON with its status, whatever the request accepts.'
    }
  }
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
              required: ['available', 'messages', 'contextTokens', 'answering'],
              properties: {
                available: { type: 'boolean' },
                messages: { type: 'array', items: message },
                contextTokens: {
                  type: 'integer',
                  description:
                    'The size of the last request and its answer; above 150,000 the conversation is compacted'
                },
                answering: {
                  type: 'boolean',
                  description:
                    'Tess is answering a message or a confirmed change now. A client whose send lost its answer reads again until this is false, then looks for its clientId'
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
          'wide screen only. The conversation is compacted first when it ' +
          'needs to be. A message whose attachments would take it above ' +
          "the model's 200,000-token window, with room for her answer, is " +
          'refused with 413: the message is not kept, and its attachments ' +
          'are, to be sent again without the one too large. A model ' +
          'failure is 503, and a message Tess had not begun to answer is ' +
          'then not kept either. While she is still answering an earlier ' +
          'message or a confirmed change, it is 409. With `Accept: ' +
          'text/event-stream` her turn is streamed as it happens.',
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
              },
              clientId: {
                type: 'string',
                pattern: '^[A-Za-z0-9_-]{1,64}$',
                description:
                  "The client's id for the message, shown on it in the conversation"
              }
            }
          })
        },
        responses: {
          200: {
            description: 'The new messages',
            content: {
              ...(json(messages) as object),
              ...(eventStream('the same body as the JSON answer') as object)
            }
          },
          400: errorResponse,
          409: errorResponse,
          413: errorResponse,
          ...refusals
        }
      }
    },
    '/me/tess/attachments': {
      post: {
        summary: 'Upload a file for a message to Tess',
        description:
          'PNG, JPEG, GIF or WebP pictures up to 3.75 MB (5 MB of base64, ' +
          'the most the model takes), and CSV, plain text ' +
          'or Markdown up to 1 MB of UTF-8, in base64. With no media type ' +
          'the kind is read from a .csv, .txt or .md name. A picture must be ' +
          'the image it says it is. The body may be up to 8 MB. Uploads ' +
          'no message names are held for one: up to 25 MB a person, past ' +
          'which an upload is 413, and each for a day, after which it is ' +
          'cleared.',
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
          'is a second confirm of the same change, and any confirm while ' +
          'Tess is still answering, which does not run it. A change still ' +
          'running a minute after it was confirmed was lost mid-run: it ' +
          'shows as unknown, and is not run again. With `Accept: ' +
          "text/event-stream` Tess's report is streamed as it happens.",
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
            content: {
              ...(json({
                type: 'object',
                required: ['change', 'messages'],
                properties: {
                  change,
                  messages: { type: 'array', items: message }
                }
              }) as object),
              ...(eventStream('the same body as the JSON answer') as object)
            }
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
