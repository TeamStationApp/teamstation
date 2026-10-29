import { openApiDocument } from '../openapi'
import { checkApiRequest } from './denyList'

/**
 * What the app says Tess is doing at each tool call she makes: "Reading:"
 * and the API document's summary of the route she reads, "Preparing a
 * change for you to confirm", or why she may not. A label is the server's
 * own words, never the call's path, query or body, so it names no id and no
 * value the person did not see.
 */

export const READING_API = 'Reading the API'
export const PREPARING_CHANGE = 'Preparing a change for you to confirm'
export const QUERYING = 'Querying TeamStation'
export const NO_SUCH_TOOL = 'Not allowed: there is no such tool.'

interface Route {
  pattern: RegExp
  /** Fixed segments: the route with the most wins over one with a parameter. */
  fixed: number
  summary: string
}

let routes: Route[] | undefined

/** Every documented GET with a summary, the most specific first. */
function readRoutes(): Route[] {
  if (routes != null) return routes
  const paths = openApiDocument('').paths as Record<
    string,
    Record<string, { summary?: unknown }>
  >
  routes = Object.entries(paths)
    .flatMap(([path, operations]) => {
      const summary = operations.get?.summary
      if (typeof summary !== 'string' || summary.trim() === '') return []
      const segments = path.split('/').filter(segment => segment !== '')
      const pattern = new RegExp(
        `^/${segments
          .map(segment =>
            /^\{[^}]+\}$/.test(segment)
              ? '[^/]+'
              : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          )
          .join('/')}$`,
        'i'
      )
      return [
        {
          pattern,
          fixed: segments.filter(segment => !segment.startsWith('{')).length,
          summary: summary.trim()
        }
      ]
    })
    .sort((a, b) => b.fixed - a.fixed)
  return routes
}

/** The first sentence of a refusal, which says what she may not do. */
function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text.trim())
  return match == null ? `${text.trim()}.` : match[0]
}

/** What a read of `path`, checked, is, by the route it reaches. */
function readingLabel(checkedPath: string): string {
  // Express takes one trailing slash, so the match does too.
  const path = checkedPath.replace(/(.)\/$/, '$1')
  const route = readRoutes().find(candidate => candidate.pattern.test(path))
  return route == null ? READING_API : `Reading: ${route.summary}`
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The label of one tool call Tess made. */
export function stepLabel(call: { name: string; input: unknown }): string {
  const input =
    call.input != null && typeof call.input === 'object'
      ? (call.input as Record<string, unknown>)
      : {}
  if (call.name === 'api_get') {
    if (typeof input.path !== 'string') return READING_API
    const checked = checkApiRequest('GET', input.path)
    return typeof checked === 'string'
      ? `Not allowed: ${firstSentence(checked)}`
      : readingLabel(checked.path)
  }
  if (call.name === 'graphql_query') return QUERYING
  if (call.name === 'confirmChange') {
    if (
      typeof input.path === 'string' &&
      typeof input.method === 'string' &&
      WRITES.has(input.method)
    ) {
      const checked = checkApiRequest(
        input.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        input.path
      )
      if (typeof checked === 'string')
        return `Not allowed: ${firstSentence(checked)}`
    }
    return PREPARING_CHANGE
  }
  return NO_SUCH_TOOL
}
