import { asObject, asOptional, asString, asUnknown } from 'cleaners'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import type { Database } from '../db/database'
import { graphqlOutline } from '../graphql/schema'
import { MAX_BATCH, proposeChange } from './changes'
import { checkApiRequest, GRAPHQL_PATH } from './denyList'
import { apiCall, type Credentials } from './loopback'
import type {
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock
} from './messagesApi'

/**
 * Tess's tools. `api_get` reads the API as the person, and `graphql_query`
 * reads many things at once through its GraphQL API; `confirmChange`
 * proposes a write, which runs only when the person confirms it. None
 * throws: a refusal or a failure is the tool's error, which the model reads
 * and explains.
 */

export const PROPOSED =
  'Shown to the user with a Confirm button. It runs only if they hold Confirm; do not say it has happened.'

/**
 * What Tess is told of a change past the most one Confirm takes: the
 * person holds Confirm for these first.
 */
export const TOO_MANY_CHANGES = `This reply already proposes ${MAX_BATCH} changes, the most one Confirm takes. Propose no more now: tell the person you will propose the rest once they have confirmed these.`

/** The largest body a proposed change may carry, as JSON. */
const MAX_CHANGE_BODY = 100000
const MAX_SUMMARY = 500
/** A change's plain-language details: this many rows at most, each this long. */
export const MAX_DETAILS = 8
export const MAX_DETAIL_LABEL = 40
export const MAX_DETAIL_VALUE = 120

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
    name: 'graphql_query',
    description:
      'Reads TeamStation through its read-only GraphQL API as the person you are helping, with their permissions: one query can gather what several api_get calls would. Answers the HTTP status and the JSON body, {data, errors}; a field the person may not read is null, with an error saying why. ' +
      `Types and fields: ${graphqlOutline()}. ` +
      'It only reads: there are no mutations.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The GraphQL query, such as { team(id: "tem_123") { name games { startAt homeScore awayScore } } }'
        },
        variables: {
          type: 'object',
          description: "Values for the query's $variables",
          additionalProperties: true
        }
      },
      required: ['query']
    }
  },
  {
    name: 'confirmChange',
    description: `Proposes one change to TeamStation for the person to confirm. Nothing changes now: the person sees it as a row of a table, with the other changes of your reply, and it runs only if they hold Confirm. Propose one change per item: each game, each player, each date its own change, up to ${MAX_BATCH} in one reply. Never use it for live scoring.`,
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
            'One sentence saying in plain words what the change does, such as "Schedule a game against Demo Eagles on Saturday at 10:00". No ids and no JSON.'
        },
        details: {
          type: 'object',
          description: `What the change sets, as the person would say it: up to ${MAX_DETAILS} label to value pairs of plain words, such as {"Opponent": "Demo Eagles", "Date": "Sat Nov 8", "Time": "10:00 AM", "Field": "Field 2"}. Each becomes a column of the table, so give changes of one kind the same labels in the same order. Labels up to ${MAX_DETAIL_LABEL} characters, values up to ${MAX_DETAIL_VALUE}. Never ids or JSON.`,
          additionalProperties: { type: 'string' }
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
const asGraphqlQuery = asObject({
  query: asString,
  variables: asOptional(asObject(asUnknown))
})
const asConfirmChange = asObject({
  method: asLiteral('POST', 'PUT', 'PATCH', 'DELETE'),
  path: asString,
  body: asOptional(asUnknown),
  summary: asString,
  details: asOptional(asObject(asUnknown))
})

/**
 * A change's details as stored, in the order the model wrote them, or a
 * reason to ask again: at most `MAX_DETAILS`, each a short label and a
 * short value, both strings. A label or value left blank is a mistake, too.
 */
export function detailsOf(
  raw: Record<string, unknown> | undefined
): Array<{ label: string; value: string }> | string | undefined {
  if (raw == null) return undefined
  const entries = Object.entries(raw)
  const ask = `Give details as up to ${MAX_DETAILS} plain-language label to value strings, each label up to ${MAX_DETAIL_LABEL} characters and each value up to ${MAX_DETAIL_VALUE}, such as {"Opponent": "Demo Eagles", "Date": "Sat Nov 8"}`
  if (entries.length > MAX_DETAILS) return ask
  const details: Array<{ label: string; value: string }> = []
  for (const [key, value] of entries) {
    const label = key.trim()
    if (typeof value !== 'string') return ask
    const text = value.trim()
    if (
      label === '' ||
      label.length > MAX_DETAIL_LABEL ||
      text === '' ||
      text.length > MAX_DETAIL_VALUE
    )
      return ask
    details.push({ label, value: text })
  }
  return details.length === 0 ? undefined : details
}

export interface ToolContext {
  db: Kysely<Database>
  userId: string
  credentials: Credentials
  origin: string
  now: Date
  /** How many changes this turn has proposed so far, over all its rounds. */
  proposals: { count: number }
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
  if (call.name === 'graphql_query') {
    let input: ReturnType<typeof asGraphqlQuery>
    try {
      input = asGraphqlQuery(call.input)
    } catch {
      return fail('graphql_query takes {query, variables?}')
    }
    const checked = checkApiRequest('POST', GRAPHQL_PATH)
    if (typeof checked === 'string') return fail(checked)
    const answer = await apiCall(
      context.origin,
      context.credentials,
      'POST',
      checked.path,
      undefined,
      {
        query: input.query,
        ...(input.variables == null ? {} : { variables: input.variables })
      }
    )
    // A field refused or a query that failed is an error she explains.
    const failed =
      answer.status < 200 ||
      answer.status >= 300 ||
      /"errors"\s*:/.test(answer.body)
    return {
      result: {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `HTTP ${answer.status}\n${answer.body}`,
        ...(failed ? { is_error: true } : {})
      }
    }
  }
  if (call.name === 'confirmChange') {
    // One hold confirms the turn's changes, and takes at most `MAX_BATCH`.
    if (context.proposals.count >= MAX_BATCH) return fail(TOO_MANY_CHANGES)
    let input: ReturnType<typeof asConfirmChange>
    try {
      input = asConfirmChange(call.input)
    } catch {
      return fail(
        'confirmChange takes {method: POST|PUT|PATCH|DELETE, path, body?, summary, details?}'
      )
    }
    const checked = checkApiRequest(input.method, input.path)
    if (typeof checked === 'string') return fail(checked)
    if (checked.path.toLowerCase().replace(/\/$/, '') === GRAPHQL_PATH)
      return fail('A GraphQL query is a read: use graphql_query')
    const summary = input.summary.trim()
    if (summary === '' || summary.length > MAX_SUMMARY)
      return fail(
        `Give a summary of one sentence, up to ${MAX_SUMMARY} characters`
      )
    if (JSON.stringify(input.body ?? null).length > MAX_CHANGE_BODY)
      return fail('That body is too large to propose')
    const details = detailsOf(input.details)
    if (typeof details === 'string') return fail(details)
    const changeId = await proposeChange(
      context.db,
      context.userId,
      {
        method: input.method,
        path: `${checked.path}${checked.search}`,
        body: input.body,
        summary,
        ...(details == null ? {} : { details })
      },
      context.now
    )
    context.proposals.count += 1
    return {
      result: { type: 'tool_result', tool_use_id: call.id, content: PROPOSED },
      changeId
    }
  }
  return fail(`There is no tool called ${call.name}`)
}
