import { asObject, asOptional, asString, asUnknown } from 'cleaners'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import type { Database } from '../db/database'
import { proposeChange } from './changes'
import { checkApiRequest } from './denyList'
import { apiCall, type Credentials } from './loopback'
import type {
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock
} from './messagesApi'

/**
 * Tess's two tools. `api_get` reads the API as the person; `confirmChange`
 * proposes a write, which runs only when the person confirms it. Neither
 * throws: a refusal or a failure is the tool's error, which the model reads
 * and explains.
 */

export const PROPOSED =
  'Shown to the user with a Confirm button. It runs only if they hold Confirm; do not say it has happened.'

/** The largest body a proposed change may carry, as JSON. */
const MAX_CHANGE_BODY = 100000
const MAX_SUMMARY = 500

export const TOOLS: ToolDefinition[] = [
  {
    name: 'api_get',
    description:
      'Reads the TeamStation API as the person you are helping, with their permissions: a GET of one path from the API index, written without /api/v1. Answers the HTTP status and the JSON body. Use it for every fact.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The API path with real ids, such as /teams/tem_123/games'
        },
        query: {
          type: 'object',
          description:
            'Query parameters, such as {"season": "sea_1"}. An array repeats the parameter.',
          additionalProperties: true
        }
      },
      required: ['path']
    }
  },
  {
    name: 'confirmChange',
    description:
      'Proposes one change to TeamStation for the person to confirm. Nothing changes now: the person sees a card with this request and it runs only if they hold its Confirm button. Never use it for live scoring.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: {
          type: 'string',
          description:
            'The API path with real ids, written without /api/v1, such as /teams/tem_123/games'
        },
        body: {
          description: 'The JSON body, as the API index describes it'
        },
        summary: {
          type: 'string',
          description:
            'One sentence saying in plain words what the change does, such as "Schedule a game against Demo Eagles on Saturday at 10:00"'
        }
      },
      required: ['method', 'path', 'summary']
    }
  }
]

const asApiGet = asObject({
  path: asString,
  query: asOptional(asObject(asUnknown))
})
const asConfirmChange = asObject({
  method: asLiteral('POST', 'PUT', 'PATCH', 'DELETE'),
  path: asString,
  body: asOptional(asUnknown),
  summary: asString
})

export interface ToolContext {
  db: Kysely<Database>
  userId: string
  credentials: Credentials
  origin: string
  now: Date
}

/** One tool call's result, and the change it proposed, if any. */
export interface ToolOutcome {
  result: ToolResultBlock
  changeId?: string
}

/** Runs one tool call. */
export async function runTool(
  context: ToolContext,
  call: ToolUseBlock
): Promise<ToolOutcome> {
  const fail = (text: string): ToolOutcome => ({
    result: {
      type: 'tool_result',
      tool_use_id: call.id,
      content: text,
      is_error: true
    }
  })
  if (call.name === 'api_get') {
    let input: ReturnType<typeof asApiGet>
    try {
      input = asApiGet(call.input)
    } catch {
      return fail('api_get takes {path, query?}')
    }
    const checked = checkApiRequest('GET', input.path)
    if (typeof checked === 'string') return fail(checked)
    const answer = await apiCall(
      context.origin,
      context.credentials,
      'GET',
      `${checked.path}${checked.search}`,
      input.query
    )
    return {
      result: {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `HTTP ${answer.status}\n${answer.body}`,
        ...(answer.status >= 200 && answer.status < 400
          ? {}
          : { is_error: true })
      }
    }
  }
  if (call.name === 'confirmChange') {
    let input: ReturnType<typeof asConfirmChange>
    try {
      input = asConfirmChange(call.input)
    } catch {
      return fail(
        'confirmChange takes {method: POST|PUT|PATCH|DELETE, path, body?, summary}'
      )
    }
    const checked = checkApiRequest(input.method, input.path)
    if (typeof checked === 'string') return fail(checked)
    const summary = input.summary.trim()
    if (summary === '' || summary.length > MAX_SUMMARY)
      return fail(
        `Give a summary of one sentence, up to ${MAX_SUMMARY} characters`
      )
    if (JSON.stringify(input.body ?? null).length > MAX_CHANGE_BODY)
      return fail('That body is too large to propose')
    const changeId = await proposeChange(
      context.db,
      context.userId,
      {
        method: input.method,
        path: `${checked.path}${checked.search}`,
        body: input.body,
        summary
      },
      context.now
    )
    return {
      result: { type: 'tool_result', tool_use_id: call.id, content: PROPOSED },
      changeId
    }
  }
  return fail(`There is no tool called ${call.name}`)
}
