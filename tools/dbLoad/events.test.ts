import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { runEvent, startEventSchedule, takeCopy } from './events'
import { seedFixture, taggedIn } from './fixture'
import { TEST_AMOUNTS } from './testAmounts'
import { openScratch, type Scratch } from './testSupport'

describe('the worst-case events', function () {
  this.timeout(120_000)

  let scratch: Scratch
  const run = 'events'
  const user = async (label: string): Promise<string> =>
    (await taggedIn(scratch.db, run, 'user')).get(label) as string
  const team = async (label: string): Promise<string> =>
    (await taggedIn(scratch.db, run, 'team')).get(label) as string

  before(async function () {
    scratch = await openScratch('events')
    await seedFixture(scratch.db, {
      runId: run,
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
  })
  after(async function () {
    await scratch.drop()
  })

  it('merges a fresh team into another, with its games', async function () {
    const result = await runEvent(scratch.db, run, 'teamMerge')
    expect(result.copy).equals(0)
    expect(result.ms).above(0)
    const from = await team('teamMerge.0.from')
    const into = await team('teamMerge.0.into')
    const row = await scratch.db
      .selectFrom('teams')
      .select('merged_into')
      .where('id', '=', from)
      .executeTakeFirstOrThrow()
    expect(row.merged_into).equals(into)
    const games = await scratch.db
      .selectFrom('games')
      .select('id')
      .where('home_team_id', '=', into)
      .execute()
    expect(games.length).equals(TEST_AMOUNTS.longTeamGames)
    // The next takes the next copy, not the one used.
    expect((await runEvent(scratch.db, run, 'teamMerge')).copy).equals(1)
  })

  it('closes a person with a long chain into another', async function () {
    const result = await runEvent(scratch.db, run, 'personMerge')
    const top = await user('personMerge.0.chain.row00010')
    const row = await scratch.db
      .selectFrom('users')
      .select('merged_into')
      .where('id', '=', top)
      .executeTakeFirstOrThrow()
    expect(row.merged_into).equals(await user('personMerge.0.keep'))
    expect(result.detail).contains('closed')
  })

  it('signs out everywhere the person with many sessions', async function () {
    const result = await runEvent(scratch.db, run, 'signOut')
    expect(result.detail).equals('revoked 20 sessions')
    const open = await scratch.db
      .selectFrom('auth_sessions')
      .select('id')
      .where('user_id', '=', await user('signOut.0.person'))
      .where('revoked_at', 'is', null)
      .execute()
    expect(open).deep.equals([])
  })

  it('asks for every game to be built again', async function () {
    const result = await runEvent(scratch.db, run, 'statsRebuild')
    expect(result.detail).matches(/^[1-9]\d* games waiting/)
  })

  it('adds people to the large chat', async function () {
    const result = await runEvent(scratch.db, run, 'chatAdd')
    expect(result.detail).equals('5 joined the large chat')
    const conversations = await taggedIn(scratch.db, run, 'conversation')
    const member = await scratch.db
      .selectFrom('chat_members')
      .select('user_id')
      .where('conversation_id', '=', conversations.get('chat.large') as string)
      .where('user_id', '=', await user('chatAdd.0.person00000'))
      .where('left_at', 'is', null)
      .execute()
    expect(member.length).equals(1)
  })

  it('fails when no copy remains, and refuses an event it does not know', async function () {
    await takeCopy(scratch.db, run, 'statsRebuild')
    await takeCopy(scratch.db, run, 'statsRebuild')
    let message = ''
    await runEvent(scratch.db, run, 'statsRebuild').catch((error: Error) => {
      message = error.message
    })
    expect(message).equals(
      `No unused copy of statsRebuild remains for run ${run}`
    )
    message = ''
    await runEvent(scratch.db, run, 'somethingElse').catch((error: Error) => {
      message = error.message
    })
    expect(message).contains('Unknown --event somethingElse')
  })

  it('runs them in turn on a schedule, carrying on past a failure', async function () {
    const logged: string[] = []
    const failed: string[] = []
    const schedule = startEventSchedule(scratch.db, run, {
      intervalMs: 150,
      log: message => logged.push(message),
      onError: error => failed.push(error.message)
    })
    await new Promise(resolve => {
      setTimeout(resolve, 1000)
    })
    const results = await schedule.stop()
    expect(results.length).above(0)
    expect(logged.length).equals(results.length)
    // statsRebuild is out of copies by now.
    expect(failed.join()).contains('No unused copy of statsRebuild')
    expect(results.map(row => row.event)).include('teamMerge')
  })
})
