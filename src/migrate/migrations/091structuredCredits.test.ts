import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  creditLabel,
  namesIn,
  type StructuredCredit
} from '../../common/scoring/storedNames'
import { userIdOfGumbo } from '../../common/userId'
import {
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  REPLAY_TEAMS
} from '../../test/replayGameFixture'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations } from './index'

type Json = Record<string, unknown>

const before091 = migrations.filter(m => m.name < '091')
const through091 = migrations.filter(m => m.name <= '091structuredCredits')

const BETTS = 9201
const FREEMAN = 9202
const PELL = 9207
const GLASNOW = 9209

/** A credit as the engine wrote it before credits carried their structure. */
function labelOnly(credit: Json): Json {
  const { head: _head, assists: _assists, assistWord: _word, ...rest } = credit
  return rest
}

/** An outside scorer's credit: a label, the person and his position. */
function outside(
  eventType: string,
  label: string,
  creditUserId: number | null,
  name: string,
  role: string,
  position: string | null,
  more: Json = {}
): Json {
  return {
    eventType,
    label,
    teamId: REPLAY_TEAMS.home.id,
    creditUserId,
    credit: { name, role, position },
    ...more
  }
}

/** The outside scorer's play, and the credits its labels have to read back. */
const OUTSIDE_CREDITS: Json[] = [
  outside('single', 'Single: Kyle Tucker', null, 'Kyle Tucker', 'batter', null),
  outside('run', 'Run: Kyle Tucker', null, 'Kyle Tucker', 'runner', null),
  outside(
    'strikeout',
    'Strikeout: Tyler Glasnow pitching',
    GLASNOW,
    'Tyler Glasnow',
    'pitcher',
    null
  ),
  outside(
    'field_out',
    'Ground out: Mookie Betts (SS) to Freddie Freeman (1B)',
    BETTS,
    'Mookie Betts',
    'fielder',
    'SS',
    {
      assists: [
        { name: 'Freddie Freeman', position: '1B', creditUserId: FREEMAN }
      ]
    }
  ),
  outside(
    'double_play',
    'Double play: Mookie Betts (SS) to Rowan Pell (2B) to Kyle Tucker (1B)',
    BETTS,
    'Mookie Betts',
    'fielder',
    'SS',
    { assists: [{ name: 'Rowan Pell', position: '2B', creditUserId: PELL }] }
  ),
  outside(
    'caught_stealing_2b',
    'Caught stealing 2nd: Tyler Glasnow (P)',
    GLASNOW,
    'Tyler Glasnow',
    'fielder',
    'P'
  ),
  outside('pickoff_1b', 'Pickoff at 1st', null, '', 'fielder', null)
]

/** A label its own credit cannot word again: the subject is spelled apart. */
const UNREAD = outside(
  'field_out',
  'Ground out: M. Betts (SS)',
  BETTS,
  'Mookie Betts',
  'fielder',
  'SS'
)

interface CreditRow {
  eventId: string
  eventType: string
  label: string
  teamId: string | null
  creditGumboId: number | null
  name: string
  role: string | null
  position: string | null
  head?: string
  suffix?: string | null
  assists?: Array<{
    gumboId: number | null
    position: string | null
    name?: string
  }>
  assistWord?: string | null
  typedName?: string | null
}

describe('091 structured credits', function () {
  this.timeout(60000)
  const name = `teamstation_credits091_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  /** Every name a stored play gives an id. */
  const names = new Map<number, string>()
  let creditsBefore: CreditRow[] = []
  let snapshotBefore: Awaited<ReturnType<typeof schemaSnapshot>>
  let functionBefore = ''
  let untouchedBefore: Array<{ id: string; xmin: string }> = []
  let structuredBefore: Array<{ id: string; gumbo: unknown }> = []

  // Without the id, which a refired trigger makes anew, and with the
  // bigint read as a number whichever parser the process has.
  const credits = async (): Promise<CreditRow[]> =>
    (
      await pool.query<CreditRow & { id?: string }>(
        `select * from "eventCredits" order by "eventId", label, "eventType"`
      )
    ).rows.map(({ id: _id, ...row }) => ({
      ...row,
      creditGumboId:
        row.creditGumboId == null ? null : Number(row.creditGumboId)
    }))
  const syncChildren = async (): Promise<string> =>
    (
      await pool.query<{ definition: string }>(
        `select pg_get_functiondef('events_sync_children()'::regprocedure)
           as definition`
      )
    ).rows[0].definition
  const insertPlay = async (
    id: string,
    gameId: string,
    gumbo: unknown
  ): Promise<void> => {
    await pool.query(
      `insert into events (id, "gameId", gumbo, source) values ($1, $2, $3, $4)`,
      [id, gameId, JSON.stringify(gumbo), 'teamstation']
    )
  }

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(pool, before091)
    for (const player of [...AWAY_PLAYERS, ...HOME_PLAYERS]) {
      const userId = userIdOfGumbo(player.gumboId)
      await pool.query(
        `insert into users (id, display_name, first_name, last_name)
         values ($1, $2, $3, $4)`,
        [userId, `${player.first} ${player.last}`, player.first, player.last]
      )
      await pool.query(
        'insert into gumbo_ids (gumbo_id, user_id) values ($1, $2)',
        [player.gumboId, userId]
      )
    }
    await pool.query(`insert into teams (id, name) values ($1, $2), ($3, $4)`, [
      REPLAY_TEAMS.away.id,
      REPLAY_TEAMS.away.name,
      REPLAY_TEAMS.home.id,
      REPLAY_TEAMS.home.name
    ])
    for (const game of ['gam_unstructured', 'gam_structured', 'gam_outside'])
      await pool.query(
        `insert into games (id, home_team_id, away_team_id, start_at)
         values ($1, $2, $3, now())`,
        [game, REPLAY_TEAMS.home.id, REPLAY_TEAMS.away.id]
      )

    const scored = await finalGame()
    for (const [index, play] of scored.plays.entries()) {
      for (const [id, fullName] of namesIn(play)) names.set(id, fullName)
      const document = play as unknown as Json
      // The engine's game as stored before its credits carried structure,
      // and the same game as the engine writes it now.
      await insertPlay(`evt_unstructured_${index}`, 'gam_unstructured', {
        ...document,
        ...(Array.isArray(document.credits)
          ? { credits: (document.credits as Json[]).map(labelOnly) }
          : {})
      })
      await insertPlay(`evt_structured_${index}`, 'gam_structured', document)
    }
    await insertPlay('evt_outside', 'gam_outside', {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'single' },
      matchup: {
        batter: { fullName: 'Kyle Tucker' },
        pitcher: { id: GLASNOW, fullName: 'Tyler Glasnow' }
      },
      credits: [...OUTSIDE_CREDITS, UNREAD]
    })
    // Looked at and credited to nobody, and stored before credits existed.
    await insertPlay('evt_empty', 'gam_outside', {
      about: { atBatIndex: 1 },
      result: { eventType: 'field_error' },
      credits: []
    })
    await insertPlay('evt_bare', 'gam_outside', {
      about: { atBatIndex: 2 },
      result: { eventType: 'single' }
    })

    creditsBefore = await credits()
    snapshotBefore = await schemaSnapshot(pool)
    functionBefore = await syncChildren()
    untouchedBefore = (
      await pool.query<{ id: string; xmin: string }>(
        `select id, xmin::text from events
         where id in ('evt_empty', 'evt_bare') order by id`
      )
    ).rows
    structuredBefore = (
      await pool.query<{ id: string; gumbo: unknown }>(
        `select id, gumbo from events where "gameId" = 'gam_structured'
         order by id`
      )
    ).rows
    await migrateUp(pool, through091)
  })

  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('keeps every credit row, its label and its name, and adds the structure', async () => {
    const after = await credits()
    const before = (row: CreditRow): Json => ({
      eventId: row.eventId,
      eventType: row.eventType,
      label: row.label,
      teamId: row.teamId,
      creditGumboId: row.creditGumboId,
      name: row.name,
      role: row.role,
      position: row.position
    })
    expect(after.map(before)).deep.equals(creditsBefore.map(before))
    expect(after.every(row => row.head !== '')).equals(true)
    expect(after.every(row => row.typedName === null)).equals(true)
  })

  it('words every engine and outside credit again from its structure', async () => {
    const rows = await credits()
    for (const row of rows) {
      if (row.label === UNREAD.label) continue
      const credited = row.creditGumboId
      const credit: StructuredCredit = {
        creditUserId: credited,
        head: row.head!,
        ...(row.suffix == null ? {} : { suffix: row.suffix }),
        credit: {
          position: row.position,
          ...(credited == null ? { name: row.name } : {})
        },
        assists: row.assists!.map(assist => ({
          creditUserId: assist.gumboId,
          position: assist.position,
          ...(assist.name == null ? {} : { name: assist.name })
        })),
        ...(row.assistWord == null
          ? {}
          : { assistWord: row.assistWord as 'from' | 'to' })
      }
      const nameOf = (id: number): string | undefined =>
        id === credited ? row.name : names.get(id)
      expect(creditLabel(credit, nameOf), row.label).equals(row.label)
    }
    // The engine's game read from its labels holds what the engine writes:
    // every fielder who assisted by his id.
    const parts = (game: string): Json[] =>
      rows
        .filter(row => row.eventId.startsWith(`evt_${game}_`))
        .map(row => ({
          play: row.eventId.slice(`evt_${game}_`.length),
          label: row.label,
          head: row.head,
          suffix: row.suffix,
          assists: row.assists
        }))
    expect(parts('unstructured')).deep.equals(parts('structured'))
    expect(
      parts('unstructured').some(row => (row.assists as unknown[]).length > 0)
    ).equals(true)
  })

  it('reads an outside scorer’s label into its parts', async () => {
    const rows = (await credits()).filter(row => row.eventId === 'evt_outside')
    const parts = (label: string): Json => {
      const row = rows.find(one => one.label === label)!
      return {
        head: row.head,
        suffix: row.suffix,
        assists: row.assists,
        assistWord: row.assistWord
      }
    }
    expect(parts('Strikeout: Tyler Glasnow pitching')).deep.equals({
      head: 'Strikeout',
      suffix: ' pitching',
      assists: [],
      assistWord: null
    })
    expect(
      parts(
        'Double play: Mookie Betts (SS) to Rowan Pell (2B) to Kyle Tucker (1B)'
      )
    ).deep.equals({
      head: 'Double play',
      suffix: null,
      assists: [
        { gumboId: PELL, position: '2B' },
        { gumboId: null, position: '1B', name: 'Kyle Tucker' }
      ],
      assistWord: 'to'
    })
    expect(parts('Pickoff at 1st')).deep.equals({
      head: 'Pickoff at 1st',
      suffix: null,
      assists: [],
      assistWord: null
    })
    // A label it cannot word again keeps its head and its person only.
    const unread = rows.find(row => row.label === UNREAD.label)!
    expect(unread).include({
      head: 'Ground out',
      suffix: null,
      creditGumboId: BETTS,
      position: 'SS'
    })
    expect(unread.assists).deep.equals([])
  })

  it('stores the structure in each play, keeping labels and names, and writes only what it changed', async () => {
    const { rows } = await pool.query<{ id: string; gumbo: Json }>(
      `select id, gumbo from events where id = 'evt_outside'`
    )
    const stored = rows[0].gumbo.credits as Json[]
    expect(stored.map(credit => credit.label)).deep.equals(
      [...OUTSIDE_CREDITS, UNREAD].map(credit => credit.label)
    )
    expect(stored.map(credit => credit.credit)).deep.equals(
      [...OUTSIDE_CREDITS, UNREAD].map(credit => credit.credit)
    )
    expect(stored[3]).deep.include({
      head: 'Ground out',
      assists: [{ creditUserId: FREEMAN, position: '1B' }],
      assistWord: 'to'
    })
    const unstructured = await pool.query<{ gumbo: Json }>(
      `select gumbo from events where id = 'evt_unstructured_0'`
    )
    expect((unstructured.rows[0].gumbo.credits as Json[])[0]).deep.include({
      label: 'Walk: Juan Soto',
      head: 'Walk'
    })
    // The engine's structured plays already held it.
    const structured = await pool.query<{ id: string; gumbo: unknown }>(
      `select id, gumbo from events where "gameId" = 'gam_structured'
       order by id`
    )
    expect(structured.rows).deep.equals(structuredBefore)
    const untouched = await pool.query<{ id: string; xmin: string }>(
      `select id, xmin::text from events
       where id in ('evt_empty', 'evt_bare') order by id`
    )
    expect(untouched.rows).deep.equals(untouchedBefore)
  })

  it('copies the structure of each credit a play is written with', async () => {
    await insertPlay('evt_later', 'gam_outside', {
      about: { atBatIndex: 3 },
      result: { eventType: 'field_out' },
      credits: [
        {
          eventType: 'field_out',
          label:
            'Out at 1st: Freddie Freeman (1B) from Mookie Betts (SS), Kyle Tucker (2B)',
          teamId: REPLAY_TEAMS.home.id,
          creditUserId: FREEMAN,
          credit: { name: 'Freddie Freeman', role: 'fielder', position: '1B' },
          head: 'Out at 1st',
          assists: [
            { creditUserId: BETTS, position: 'SS', name: 'Mookie Betts' },
            { creditUserId: null, position: '2B', name: 'Kyle Tucker' },
            'not an assist'
          ],
          assistWord: 'from'
        }
      ]
    })
    const [row] = (await credits()).filter(one => one.eventId === 'evt_later')
    expect(row).include({
      head: 'Out at 1st',
      suffix: null,
      assistWord: 'from',
      name: 'Freddie Freeman',
      creditGumboId: FREEMAN
    })
    expect(row.assists).deep.equals([
      { gumboId: BETTS, position: 'SS' },
      { gumboId: null, position: '2B', name: 'Kyle Tucker' }
    ])
  })

  it('gives a typed name only to a credit that names nobody by id', async () => {
    const refused = await pool
      .query(
        `update "eventCredits" set "typedName" = 'Kyle Tucker'
         where "creditGumboId" is not null`
      )
      .then(
        () => undefined,
        (error: unknown) => String(error)
      )
    expect(refused).contains('eventCredits_typedName_check')
    await pool.query(
      `update "eventCredits" set "typedName" = name
       where "creditGumboId" is null`
    )
  })

  it('rolls back to the schema and the trigger function 068 left', async () => {
    await pool.query(`delete from events where id = 'evt_later'`)
    expect(await migrateDown(pool, through091, 1)).deep.equals([
      '091structuredCredits'
    ])
    expect(await schemaSnapshot(pool)).deep.equals(snapshotBefore)
    expect(await syncChildren()).equals(functionBefore)
    // The trigger as it was: a credit written now copies label and name only.
    await pool.query(`update events set gumbo = gumbo where id = 'evt_outside'`)
    const outsideRows = (await credits()).filter(
      row => row.eventId === 'evt_outside'
    )
    expect(outsideRows.map(row => row.label)).deep.equals(
      creditsBefore
        .filter(row => row.eventId === 'evt_outside')
        .map(row => row.label)
    )
    expect(outsideRows[0]).not.to.have.property('head')
  })
})
