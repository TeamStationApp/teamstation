import { isDeepStrictEqual } from 'node:util'

import type { PoolClient } from 'pg'

import { type PlaySource, storedForm } from '../../common/scoring/storedNames'
import { type Migration, rewriteJson, STEP_BATCH } from '../runner'
import {
  CREDIT_091,
  SYNC_CHILDREN_091,
  syncChildren
} from './091structuredCredits'

/**
 * Game documents keep no names. A person's name is read from `users` when a
 * game is read, so every stored play (`events.gumbo`), at-bat in progress
 * (`games."currentPlay"`), pregame (`games.pregame`) and archived game
 * (`game_play_archives`: its `current_play`, its `pregame` and each play in
 * `plays`) is rewritten in its stored form (`storedForm`, as the write path
 * stores a post): a version 1 record is upgraded, each sentence stored with
 * no `said` is given one read back from its words (`saidFromDescription`),
 * and then every name of a person with an id is taken out. A reference with
 * no id keeps its typed name.
 *
 * `"eventCredits"` keeps a typed name only for a credit naming nobody by id
 * (`"typedName"`), and `events_sync_children` copies the structure and that
 * name, so `label` and `name` go. So do `games.gumbo_game_data` and
 * `games.boxscore`, which nothing reads or writes.
 *
 * The step reports what it could not carry over as a notice: sentences no
 * reading of their words gives back (they read in the current wording), and
 * version 1 records `upgradeRecord` refuses (kept at version 1, their
 * players' names taken out and their sentences kept as they are).
 *
 * Names cannot be put back: rolling back raises.
 */

/** One credit's row: its structure and a typed name, no label or name. */
const CREDIT_092 = `      insert into "eventCredits" (
        id, "eventId", "eventType", "teamId", "creditGumboId",
        role, position, head, suffix, assists, "assistWord", "typedName",
        "positionShown"
      ) values (
        ts_make_id('evc'),
        new.id,
        coalesce(credit->>'eventType', ''),
        credit->>'teamId',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number'
            then (credit->>'creditUserId')::bigint
          else null
        end,
        credit #>> '{credit,role}',
        credit #>> '{credit,position}',
        coalesce(credit->>'head', ''),
        credit->>'suffix',
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'gumboId',
              case
                when jsonb_typeof(assist->'creditUserId') = 'number'
                  then assist->'creditUserId'
                else 'null'::jsonb
              end,
              'position',
              case
                when jsonb_typeof(assist->'position') = 'string'
                  then assist->'position'
                else 'null'::jsonb
              end
            ) || case
              when jsonb_typeof(assist->'creditUserId') <> 'number'
                   and jsonb_typeof(assist->'name') = 'string'
                then jsonb_build_object('name', assist->'name')
              else '{}'::jsonb
            end
            order by ordinal
          )
          from jsonb_array_elements(
            case
              when jsonb_typeof(credit->'assists') = 'array'
                then credit->'assists'
              else '[]'::jsonb
            end
          ) with ordinality as listed(assist, ordinal)
          where jsonb_typeof(assist) = 'object'
        ), '[]'::jsonb),
        credit->>'assistWord',
        case
          when jsonb_typeof(credit->'creditUserId') = 'number' then null
          when jsonb_typeof(credit #> '{credit,name}') = 'string'
            then nullif(credit #>> '{credit,name}', '')
          else null
        end,
        credit->'positionShown' is distinct from 'false'::jsonb
      );
`

const SYNC_CHILDREN_092 = SYNC_CHILDREN_091.replace(CREDIT_091, CREDIT_092)
if (SYNC_CHILDREN_092 === SYNC_CHILDREN_091)
  throw new Error('092playerNamesFromUsers: no credit insert to replace')

/** What the step could not carry over, and what it rewrote. */
interface Counts {
  documents: number
  unreproduced: number
  refused: number
}

const SOURCES: ReadonlySet<string> = new Set([
  'external',
  'manual',
  'teamstation'
])

/** A play's source as the write path stores it, or none for one unknown. */
function sourceOf(raw: unknown): PlaySource | undefined {
  return typeof raw === 'string' && SOURCES.has(raw)
    ? (raw as PlaySource)
    : undefined
}

/** `document`'s stored form, its counts added to `counts`. */
function stored(
  counts: Counts,
  document: unknown,
  source?: PlaySource
): unknown {
  if (document == null) return document
  const form = storedForm(document, source == null ? {} : { source })
  counts.unreproduced += form.unreproduced
  counts.refused += form.refused
  return form.document
}

/** Every stored play rewritten, each by the source that wrote it. */
async function rewritePlays(
  client: PoolClient,
  counts: Counts
): Promise<number> {
  let after: string | null = null
  let written = 0
  for (;;) {
    const {
      rows
    }: { rows: Array<{ id: string; gumbo: unknown; source: unknown }> } =
      await client.query(
        `select id, gumbo, source from events
         where ($1::text is null or id > $1)
         order by id limit ${STEP_BATCH}`,
        [after]
      )
    for (const row of rows) {
      const next = stored(counts, row.gumbo, sourceOf(row.source))
      const text = JSON.stringify(next ?? null)
      if (isDeepStrictEqual(JSON.parse(text), row.gumbo)) continue
      await client.query(`update events set gumbo = $2::jsonb where id = $1`, [
        row.id,
        text
      ])
      written++
    }
    if (rows.length < STEP_BATCH) return written
    after = rows[rows.length - 1].id
  }
}

/** An archived game's plays, each as the events row it was, rewritten. */
function archivedPlays(counts: Counts, raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map(row => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return row
    const play = row as Record<string, unknown>
    if (!('gumbo' in play)) return play
    return { ...play, gumbo: stored(counts, play.gumbo, sourceOf(play.source)) }
  })
}

/** The step: every game document in its stored form, and a notice. */
export async function storeWithoutNames(client: PoolClient): Promise<Counts> {
  const counts: Counts = { documents: 0, unreproduced: 0, refused: 0 }
  counts.documents += await rewritePlays(client, counts)
  for (const column of ['"currentPlay"', 'pregame'])
    counts.documents += await rewriteJson(
      client,
      { table: 'games', column, where: `${column} is not null` },
      value => stored(counts, value)
    )
  for (const column of ['current_play', 'pregame'])
    counts.documents += await rewriteJson(
      client,
      { table: 'game_play_archives', column, where: `${column} is not null` },
      value => stored(counts, value)
    )
  counts.documents += await rewriteJson(
    client,
    { table: 'game_play_archives', column: 'plays' },
    value => archivedPlays(counts, value)
  )
  const message =
    `092playerNamesFromUsers: ${counts.documents} documents rewritten, ` +
    `${counts.unreproduced} sentences not reproduced, ` +
    `${counts.refused} version 1 records refused`
  await client.query(
    `do $notice$ begin raise notice '%', ${literal(message)}; end $notice$`
  )
  return counts
}

/** A SQL string literal. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

export const migration092PlayerNamesFromUsers: Migration = {
  name: '092playerNamesFromUsers',
  up: `
update "eventCredits" set "typedName" = nullif(name, '')
where "creditGumboId" is null;

${syncChildren(SYNC_CHILDREN_092)}

alter table "eventCredits" drop column label, drop column name;
alter table games drop column gumbo_game_data, drop column boxscore;
`,
  steps: async client => {
    await storeWithoutNames(client)
  },
  down: `do $restore$ begin
    raise exception 'Restore the verified pre-cutover backup and matching code; names taken out of game documents cannot be put back';
  end $restore$;`
}
