import { sql } from 'kysely'

import { makeId } from '../../src/common/ids'
import { mergeTeams } from '../../src/server/admin/mergeTeams'
import { closeInto } from '../../src/server/admin/people'
import { signOutEverywhere } from '../../src/server/auth/sessions'
import { reconcileScope } from '../../src/server/chat/reconciler'
import { atomic } from '../../src/server/db/atomic'
import { addToScope } from '../../src/server/invites/people'
import { requestAllGameStats } from '../../src/server/statsBuilder/request'
import { type LoadDatabase, requireLoadDatabase } from './database'
import { type Consumable, CONSUMABLES, systemOf, taggedIn } from './fixture'

/**
 * The worst-case events, each through the app's own function. A merge uses up
 * the rows it merges, so each run of an event takes the next fresh copy the
 * fixture seeded, and two processes cannot take the same one.
 */

export interface EventResult {
  event: Consumable
  copy: number
  startedAt: number
  ms: number
  /** What the event did, in its own function's terms. */
  detail: string
}

/** Claims the next unused copy of a shape, or fails when none remains. */
export async function takeCopy(
  db: LoadDatabase,
  runId: string,
  event: Consumable
): Promise<number> {
  const copies = await taggedIn(db, runId, 'copy')
  const used = await taggedIn(db, runId, 'used')
  const fresh = [...copies.keys()]
    .filter(key => key.startsWith(`${event}.`) && !used.has(key))
    .map(key => Number(key.split('.')[1]))
    .sort((a, b) => a - b)
  for (const copy of fresh) {
    const claim = await db
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'used',
        entity_id: String(copy),
        system: systemOf(runId),
        kind: 'used',
        external_id: `${event}.${copy}`
      })
      .onConflict(oc =>
        oc.columns(['system', 'kind', 'external_id']).doNothing()
      )
      .returning('id')
      .executeTakeFirst()
    if (claim != null) return copy
  }
  throw new Error(`No unused copy of ${event} remains for run ${runId}`)
}

type EventWork = (
  db: LoadDatabase,
  labelled: (kind: string, label: string, top?: boolean) => string,
  copy: number,
  people: string[]
) => Promise<string>

/** The open row at the head of a copy's chain, whichever depth it was seeded at. */
function chainTop(
  labelled: (kind: string, label: string, top?: boolean) => string,
  copy: number
): string {
  return labelled('user', `personMerge.${copy}.chain.row`, true)
}

const WORK: Record<Consumable, EventWork> = {
  teamMerge: async (db, labelled, copy) => {
    const report = await mergeTeams(db, {
      fromTeamId: labelled('team', `teamMerge.${copy}.from`),
      intoTeamId: labelled('team', `teamMerge.${copy}.into`),
      apply: true
    })
    return `moved ${report.repointed['games.home_team_id'] ?? 0} games`
  },
  personMerge: async (db, labelled, copy) => {
    const merge = await closeInto(
      db,
      chainTop(labelled, copy),
      labelled('user', `personMerge.${copy}.keep`)
    )
    if (!merge.closed) throw new Error('The chain did not close')
    return `closed a chain, moved ${merge.moved} team rows`
  },
  signOut: async (db, labelled, copy) => {
    const signedOut = await signOutEverywhere(
      db,
      labelled('user', `signOut.${copy}.person`)
    )
    return `revoked ${signedOut.sessions} sessions`
  },
  statsRebuild: async db => {
    await requestAllGameStats(db)
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from game_stats_state where status = 'pending'
    `.execute(db)
    return `${rows[0].n} games waiting to be built`
  },
  chatAdd: async (db, labelled, _copy, people) => {
    const teamId = labelled('team', 'chat.largeTeam')
    for (const person of people)
      await atomic(db, async trx => {
        await addToScope(trx, 'team', teamId, person)
      })
    const reconciled = await reconcileScope(db, 'teamMembers', teamId)
    return `${reconciled.joined.length} joined the large chat`
  }
}

/** Runs one event on its own fresh copy, and times it. */
export async function runEvent(
  db: LoadDatabase,
  runId: string,
  event: string
): Promise<EventResult> {
  if (!CONSUMABLES.includes(event as Consumable))
    throw new Error(
      `Unknown --event ${event}. Events: ${CONSUMABLES.join(', ')}`
    )
  await requireLoadDatabase(
    async text =>
      await sql.raw<{ comment: string | null; name: string }>(text).execute(db)
  )
  const name = event as Consumable
  const copy = await takeCopy(db, runId, name)
  const tags = new Map<string, Map<string, string>>()
  for (const kind of ['team', 'user'])
    tags.set(kind, await taggedIn(db, runId, kind))
  const labelled = (kind: string, label: string, top = false): string => {
    const held = tags.get(kind)
    const name = top
      ? [...(held?.keys() ?? [])]
          .filter(key => key.startsWith(label))
          .sort()
          .pop()
      : label
    const id = name == null ? undefined : held?.get(name)
    if (id == null) throw new Error(`Run ${runId} has no ${kind} ${label}`)
    return id
  }
  const people = [...(tags.get('user')?.entries() ?? [])]
    .filter(([label]) => label.startsWith(`chatAdd.${copy}.person`))
    .map(([, id]) => id)
  const startedAt = Date.now()
  const started = performance.now()
  const detail = await WORK[name](db, labelled, copy, people)
  return {
    event: name,
    copy,
    startedAt,
    ms: performance.now() - started,
    detail
  }
}

export interface EventSchedule {
  stop: () => Promise<EventResult[]>
}

/**
 * Runs the events in turn, one each interval, for as long as the load does. An
 * event that fails is reported and the next still runs at its time.
 */
export function startEventSchedule(
  db: LoadDatabase,
  runId: string,
  options: {
    intervalMs?: number
    log?: (message: string) => void
    onError?: (error: Error) => void
  } = {}
): EventSchedule {
  const results: EventResult[] = []
  let turn = 0
  let running: Promise<void> = Promise.resolve()
  const timer = setInterval(
    () => {
      const event = CONSUMABLES[turn++ % CONSUMABLES.length]
      running = running.then(async () => {
        try {
          const result = await runEvent(db, runId, event)
          results.push(result)
          options.log?.(
            `event ${result.event}: ${result.ms.toFixed(0)} ms, ${result.detail}`
          )
        } catch (error) {
          options.onError?.(error as Error)
        }
      })
    },
    options.intervalMs ?? 5 * 60_000
  )
  return {
    stop: async () => {
      clearInterval(timer)
      await running
      return results
    }
  }
}
