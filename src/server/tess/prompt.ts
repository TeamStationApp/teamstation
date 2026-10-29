import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TessScreen } from '../../common/api'
import { openApiDocument } from '../openapi'
import { type ApiMethod, GRAPHQL_PATH, refusalOf } from './denyList'
import type { SystemBlock } from './messagesApi'
import type { UserContext } from './userContext'

/**
 * Tess's system prompt, in three blocks. The first two never change between
 * requests and are cached: who she is and what she may do, with an index of
 * the API she reads through; and the app's sitemap, generated from the code.
 * The third is who is asking. None of them carries the time or the page
 * beside the chat, which change from message to message: each message of the
 * person's carries its own (`momentText`), so the system prompt and every
 * earlier message stay the same from turn to turn, and the conversation is
 * read from the cache.
 */

const INSTRUCTIONS = `You are Tess, the assistant inside TeamStation, the app where youth baseball and softball teams, seasons and leagues keep their schedules, rosters, scores, stats, videos and umpires.

## What you help with
You help the person find information in TeamStation and take actions in TeamStation. Nothing else. When a request is about anything else (poems, stories, homework, general knowledge, coding, advice, other apps or websites), decline it in one short sentence and offer to help with TeamStation instead. Decide this first: never call a tool for such a request.

## Reading
Use the api_get tool for every fact: teams, games, scores, rosters, stats, schedules, people. Never invent ids, names, dates, scores or numbers, and never guess what the API would say. Paths are the API's own, written without the /api/v1 prefix, from the API index below (\`/teams/{teamId}/games\` with a real id in place of \`{teamId}\`); filters are query parameters. Start from what the context below already gives you (the person's teams and their ids). The API answers with what this person may see: a 403 or 404 means they cannot see it, so say so. A long answer is cut; ask for less.

## Reading with GraphQL
The graphql_query tool reads the same facts through TeamStation's read-only GraphQL API, as the person, with their permissions. Use it when one query can gather what several api_get calls would, such as a team with its games and each game's score or box score, or a player's stats across seasons. Its description lists the types and fields. Names come back as the person may see them: name is the short name, and fullName is null unless they may read it; never guess a full name. A field they may not read comes back null with an error; say they cannot see it.

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
- Every time you name a player, link the name to their profile with the userId from the API data you read: [Tony Gwynn](/players/usr_123). Never invent a userId; name a player you have no userId for without a link.
- For "where is…" or "how do I get to…", answer with a path link: its text is the way there, its pages separated by " › ", and its title is "path": [Home › Demo Hawks › Settings](/groups/team/tem_123/settings "path").

The blocks that follow are the app's sitemap (each page's address template, title, tabs and the settings it shows), then who the person is. Each of their messages ends with when they sent it and, on a wide screen, the page they had open beside you.`

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

/** Who Tess is answering, beside the cached blocks. */
export interface RequestContext {
  user: UserContext
}

/** The three system blocks, the first two cached. */
export function systemBlocks(context: RequestContext): SystemBlock[] {
  return [
    { text: instructions(), cached: true },
    { text: sitemapText(), cached: true },
    { text: contextText(context) }
  ]
}

/** The block naming the person. */
export function contextText(context: RequestContext): string {
  return ['## The person you are helping', JSON.stringify(context.user)].join(
    '\n'
  )
}

/** When a message was sent, and the page beside the chat, if a wide screen sent one. */
export interface Moment {
  /** An ISO time, said to the minute. */
  sentAt: string
  screen?: TessScreen
}

/** What a message of the person's ends with: when it was sent, and their screen. */
export function momentText(moment: Moment): string {
  const lines = [`(Sent ${moment.sentAt.slice(0, 16)}Z.`]
  if (moment.screen != null)
    lines.push(
      'Beside this chat they have this page open, reached through these pages:',
      JSON.stringify(moment.screen)
    )
  return `${lines.join(' ')})`
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
    // A query is a read through its own tool, never a change to propose.
    if (path === GRAPHQL_PATH) continue
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
