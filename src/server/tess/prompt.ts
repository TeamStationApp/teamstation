import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TessScreen } from '../../common/api'
import { openApiDocument } from '../openapi'
import { type ApiMethod, refusalOf } from './denyList'
import type { SystemBlock } from './messagesApi'
import type { UserContext } from './userContext'

/**
 * Tess's system prompt, in three blocks. The first two never change between
 * requests and are cached: who she is and what she may do, with an index of
 * the API she reads through; and the app's sitemap, generated from the code.
 * The third is this request's own: who is asking, the time, and on a wide
 * screen the page beside the chat.
 */

const INSTRUCTIONS = `You are Tess, the assistant inside TeamStation, the app where youth baseball and softball teams, seasons and leagues keep their schedules, rosters, scores, stats, videos and umpires.

## What you help with
You help the person find information in TeamStation and take actions in TeamStation. Nothing else. When a request is about anything else (poems, stories, homework, general knowledge, coding, advice, other apps or websites), decline it in one short sentence and offer to help with TeamStation instead. Decide this first: never call a tool for such a request.

## Reading
Use the api_get tool for every fact: teams, games, scores, rosters, stats, schedules, people. Never invent ids, names, dates, scores or numbers, and never guess what the API would say. Paths are the API's own, written without the /api/v1 prefix, from the API index below (\`/teams/{teamId}/games\` with a real id in place of \`{teamId}\`); filters are query parameters. Start from what the context below already gives you (the person's teams and their ids). The API answers with what this person may see: a 403 or 404 means they cannot see it, so say so. A long answer is cut; ask for less.

## Changing things
You never change anything yourself. Propose every change with the confirmChange tool: the method, the path, the body as the API index describes it, and a one-sentence summary in plain words. The person sees a card and the change runs only if they hold its Confirm button. Read what the change needs first (ids, current values) with api_get. After proposing, say what you proposed and that they can hold Confirm. Never say a change has happened, or will happen, until a later message reports what the server answered.

## What you never do
- Live scoring: you cannot record pitches, plays, outs, runs or substitutions, change a game's lineup during play, or start or change live video. Do not propose such a change. Say that the scorekeeper does it on the game's scoring screen.
- The person's account: you cannot change how they sign in, their password, e-mail addresses or name, or delete their account. Point them to the Account page.
- Never say you opened, showed or navigated to a page. The person taps a link.

## How you answer
Write chat Markdown: short paragraphs, lists, bold. Keep answers brief and specific.
- A table is an HTML <table> with <thead> and <tbody>. A chart is an inline <svg> with a viewBox, width and height, axis labels and a title. No scripts, no event handlers, and nothing loaded from elsewhere: no external images, fonts, styles or links inside them.
- Link pages of the app with Markdown links to app paths from the sitemap, with real ids in place of the :parameters: [Demo Hawks](/teams/tem_123). Never link to /api/v1.
- For "where is…" or "how do I get to…", answer with a path link: its text is the way there, its pages separated by " › ", and its title is "path": [Home › Demo Hawks › Settings](/groups/team/tem_123/settings "path").

The blocks that follow are the app's sitemap (each page's address template, title, tabs and the settings it shows), then who the person is, the current time and, on a wide screen, the page they have open beside you.`

/** The longest line one route takes in the index. */
const MAX_INDEX_LINE = 900

let cachedIndex: string | undefined
let cachedSitemap: string | undefined

/**
 * The static instructions, with an index of the API Tess may use: one line a
 * route, its summary, its query parameters and, for a write, its body's
 * shape. Routes the deny list refuses are left out.
 */
export function instructions(): string {
  cachedIndex ??= apiIndex()
  return `${INSTRUCTIONS}\n\n## API index\nEach line is METHOD path: summary. Query lists a read's parameters; Body is a write's JSON, * marking what is required.\n${cachedIndex}`
}

/** The sitemap generated from the code, as compact JSON. */
export function sitemapText(): string {
  cachedSitemap ??= JSON.stringify(
    JSON.parse(readFileSync(join(__dirname, 'sitemap.generated.json'), 'utf8'))
  )
  return `## App sitemap\n${cachedSitemap}`
}

/** What one request tells Tess about now, beside the cached blocks. */
export interface RequestContext {
  user: UserContext
  now: Date
  /** The page open beside the chat, sent by a wide screen only. */
  screen?: TessScreen
}

/** The three system blocks, the first two cached. */
export function systemBlocks(context: RequestContext): SystemBlock[] {
  return [
    { text: instructions(), cached: true },
    { text: sitemapText(), cached: true },
    { text: contextText(context) }
  ]
}

/** The per-request block. Only a screen the client sent appears in it. */
export function contextText(context: RequestContext): string {
  const lines = [
    '## Now',
    `The time is ${context.now.toISOString()} (UTC).`,
    '',
    '## The person you are helping',
    JSON.stringify(context.user)
  ]
  if (context.screen != null)
    lines.push(
      '',
      '## Their screen',
      'Beside this chat they have this page open, reached through these pages:',
      JSON.stringify(context.screen)
    )
  return lines.join('\n')
}

type Schema = Record<string, unknown>

/** One line per route the deny list allows, in the document's order. */
function apiIndex(): string {
  const document = openApiDocument('')
  const components =
    (document as { components?: { schemas?: Record<string, Schema> } })
      .components?.schemas ?? {}
  const lines: string[] = []
  for (const [path, entry] of Object.entries(
    document.paths as Record<string, Record<string, Schema>>
  )) {
    for (const [method, operation] of Object.entries(entry)) {
      const upper = method.toUpperCase() as ApiMethod
      if (refusalOf(upper, path.replace(/\{[^}]+\}/g, 'x')) != null) continue
      let line = `${upper} ${path}: ${typeof operation.summary === 'string' ? operation.summary : ''}`
      const query = (
        (operation.parameters as Schema[] | undefined) ?? []
      ).filter(parameter => parameter.in === 'query')
      if (query.length > 0)
        line += `. Query: ${query.map(parameter => String(parameter.name)).join(', ')}`
      const body = (
        (operation.requestBody as Schema | undefined)?.content as
          Record<string, { schema?: Schema }> | undefined
      )?.['application/json']?.schema
      if (upper !== 'GET' && body != null)
        line += `. Body: ${shapeOf(body, components, 0)}`
      lines.push(
        line.length > MAX_INDEX_LINE
          ? `${line.slice(0, MAX_INDEX_LINE - 1)}…`
          : line
      )
    }
  }
  return lines.join('\n')
}

/** A schema written short, as a TypeScript-like type, three levels deep. */
function shapeOf(
  schema: Schema,
  components: Record<string, Schema>,
  depth: number
): string {
  const ref = schema.$ref
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '')
    const target = components[name]
    return target == null || depth > 2
      ? name
      : shapeOf(target, components, depth + 1)
  }
  const variants = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined
  if (variants != null)
    return variants.map(each => shapeOf(each, components, depth)).join(' | ')
  if (Array.isArray(schema.enum))
    return schema.enum.map(value => JSON.stringify(value)).join('|')
  const type = schema.type
  if (type === 'array') {
    const items = schema.items as Schema | undefined
    return `${items == null ? 'unknown' : shapeOf(items, components, depth)}[]`
  }
  if (type === 'object' || schema.properties != null) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    const names = Object.keys(properties)
    if (names.length === 0) return 'object'
    if (depth > 2) return '{…}'
    const required = new Set((schema.required as string[] | undefined) ?? [])
    return `{${names
      .map(
        name =>
          `${name}${required.has(name) ? '*' : ''}: ${shapeOf(properties[name], components, depth + 1)}`
      )
      .join(', ')}}`
  }
  if (typeof schema.format === 'string') return schema.format
  if (Array.isArray(type)) return type.join('|')
  return typeof type === 'string' ? type : 'unknown'
}
