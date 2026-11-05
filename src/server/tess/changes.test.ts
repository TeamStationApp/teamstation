import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import type { Response as ExpressResponse } from 'express'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  asTessConfirmation,
  asTessConfirmations,
  asTessConversation,
  type TessChange
} from '../../common/api'
import {
  callTools,
  readTurnStream,
  say,
  type TessWorld,
  tessWorld
} from '../../test/tessFakes'
import {
  CHANGE_TTL_MS,
  changesById,
  changeView,
  LOST_AFTER_MS,
  MAX_BATCH,
  proposeChange,
  runChange,
  runChanges,
  UNKNOWN_CHANGE
} from './changes'
import { MAX_DETAIL_VALUE, MAX_DETAILS, TOO_MANY_CHANGES } from './tools'

type Block = Record<string, any>

/**
 * A change runs only when its person holds Confirm: once, with their own
 * credentials, through the same API as a tap. Tess then reports it.
 */
describe("Tess's changes", function () {
  this.timeout(60000)
  let w: TessWorld

  // A write that is still working on its answer when the loopback gives up.
  const hanging: ExpressResponse[] = []

  before(async () => {
    w = await tessWorld({
      mountExtra: app => {
        app.put('/api/v1/me/slow-write', (_req, res) => {
          hanging.push(res)
        })
      }
    })
  })
  after(async () => {
    for (const res of hanging) res.end()
    await w?.close()
  })
  beforeEach(async () => {
    for (const table of [
      'tess_messages',
      'tess_changes',
      'tess_conversations',
      'follows',
      'audit_log'
    ] as const)
      await w.h.db.deleteFrom(table).execute()
    w.model.calls.length = 0
    w.setNow(undefined)
  })

  /** Has Tess propose this change to user 101, and answers its card. */
  const propose = async (
    input: Record<string, unknown>,
    gumbo = 101
  ): Promise<TessChange> => {
    w.model.reply(
      callTools([{ name: 'confirmChange', input }]),
      say('Hold Confirm to do it.')
    )
    const response = await w.h.request(
      'POST',
      '/me/tess/messages',
      { text: 'Please do it' },
      gumbo
    )
    expect(response.status).equals(200)
    const conversation = asTessConversation(
      await (await w.h.request('GET', '/me/tess', undefined, gumbo)).json()
    )
    const changes = conversation.messages.flatMap(message => message.changes)
    expect(changes.length).greaterThan(0)
    return changes[changes.length - 1]
  }
  const follow = {
    method: 'PUT',
    path: '/me/follows/team/tem_account',
    summary: 'Follow Demo Hawks'
  }
  const confirm = async (id: string, gumbo = 101): Promise<Response> =>
    await w.h.request(
      'POST',
      `/me/tess/changes/${id}/confirm`,
      undefined,
      gumbo
    )
  const followWrites = async (): Promise<number> =>
    (
      await w.h.db
        .selectFrom('audit_log')
        .select('id')
        .where('path', '=', '/api/v1/me/follows/team/tem_account')
        .execute()
    ).length

  it('stores a proposed change as pending and shows its card, from the stored request', async () => {
    const change = await propose({ ...follow, body: { note: 'fan' } })
    expect(change).deep.include({
      summary: 'Follow Demo Hawks',
      method: 'PUT',
      path: '/me/follows/team/tem_account',
      body: { note: 'fan' },
      status: 'pending'
    })
    const row = await w.h.db
      .selectFrom('tess_changes')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(
      new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()
    ).closeTo(CHANGE_TTL_MS, 5000)
    // The card says when it expires, for the app to stop waiting then, and
    // how long it has left as of the answer, for an app whose clock is not
    // the server's.
    expect(change.expiresAt).equals(new Date(row.expires_at).toISOString())
    expect(change.expiresInMs).closeTo(CHANGE_TTL_MS, 5000)
    expect(
      changeView(row, new Date(new Date(row.expires_at).getTime() - 60000))
        .expiresInMs
    ).equals(60000)
    expect(
      changeView(row, new Date(new Date(row.expires_at).getTime() + 1000))
        .expiresInMs
    ).equals(0)
    expect(await followWrites()).equals(0)
  })

  it('runs the change once however often it is confirmed, then Tess reports it', async () => {
    const change = await propose(follow)
    w.model.reply(say('You now follow Demo Hawks.'))
    const answers = await Promise.all([confirm(change.id), confirm(change.id)])
    expect(
      answers.map(answer => answer.status).sort((a, b) => a - b)
    ).deep.equals([200, 409])
    const confirmed = asTessConfirmation(
      await answers.find(answer => answer.status === 200)!.json()
    )
    expect(confirmed.change).deep.include({ id: change.id, status: 'done' })
    expect(confirmed.messages.map(message => message.text)).deep.equals([
      'You now follow Demo Hawks.'
    ])
    expect(await followWrites()).equals(1)
    const follows = await w.h.request('GET', '/me/follows')
    expect(
      ((await follows.json()) as Array<{ id: string }>).map(group => group.id)
    ).deep.equals(['tem_account'])
    // What Tess was told, as a note that is not shown as the person's.
    const report = w.model.messageCalls().at(-1) as Block
    expect(report.messages.at(-1).content.at(-1).text).match(
      /^The user confirmed the change "Follow Demo Hawks" \(PUT \/me\/follows\/team\/tem_account\); the server answered 200: \{/
    )
    const shown = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages
    expect(shown.map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'assistant'
    ])
    expect(shown[1].changes[0].status).equals('done')
    // Done is done.
    const again = await confirm(change.id)
    expect(again.status).equals(409)
    expect(((await again.json()) as { message: string }).message).includes(
      'already done'
    )
  })

  it('shows a change lost mid-run as unknown, and refuses to run it again with a note to check it', async () => {
    const change = await propose(follow)
    const started = new Date()
    await w.h.db
      .updateTable('tess_changes')
      .set({ status: 'running', started_at: started })
      .execute()
    const shown = async (): Promise<string> =>
      asTessConversation(
        await (await w.h.request('GET', '/me/tess')).json()
      ).messages.flatMap(message => message.changes)[0].status
    // Within its request's deadline it may still be running.
    expect(await shown()).equals('running')
    const running = await confirm(change.id)
    expect(running.status).equals(409)
    expect(((await running.json()) as { message: string }).message).includes(
      'already running'
    )

    // Long after, a deploy or a failed update lost it.
    w.setNow(new Date(started.getTime() + LOST_AFTER_MS + 1000))
    expect(await shown()).equals('unknown')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lost = await confirm(change.id)
      expect(lost.status).equals(409)
      expect(((await lost.json()) as { message: string }).message).equals(
        UNKNOWN_CHANGE
      )
    }
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select('status')
      .executeTakeFirstOrThrow()
    expect(row.status).equals('unknown')
    expect(await shown()).equals('unknown')
    expect(await followWrites()).equals(0)
  })

  it('records when a confirmed change began to run', async () => {
    const change = await propose(follow)
    const before = Date.now()
    expect((await confirm(change.id)).status).equals(200)
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select(['status', 'started_at'])
      .executeTakeFirstOrThrow()
    expect(row.status).equals('done')
    expect(new Date(row.started_at!).getTime()).within(
      before - 1000,
      Date.now() + 1000
    )
  })

  it('answers 404 for another person’s change, and for no change at all', async () => {
    const change = await propose(follow)
    expect((await confirm(change.id, 102)).status).equals(404)
    expect((await confirm(randomUUID())).status).equals(404)
    expect((await confirm('not-a-change')).status).equals(404)
    expect(await followWrites()).equals(0)
  })

  it('answers 409 for a change past its time, and marks it expired', async () => {
    const change = await propose(follow)
    w.setNow(new Date(Date.now() + CHANGE_TTL_MS + 1000))
    const late = await confirm(change.id)
    expect(late.status).equals(409)
    expect(((await late.json()) as { message: string }).message).includes(
      'expired'
    )
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select('status')
      .executeTakeFirstOrThrow()
    expect(row.status).equals('expired')
    expect(await followWrites()).equals(0)
  })

  it('stores a write the server refused as failed, with its answer', async () => {
    const change = await propose({
      ...follow,
      path: '/me/follows/team/tem_missing',
      summary: 'Follow a team that is not there'
    })
    w.model.reply(say('That did not work: the team was not found.'))
    const confirmed = asTessConfirmation(
      await (await confirm(change.id)).json()
    )
    expect(confirmed.change.status).equals('failed')
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select('result')
      .executeTakeFirstOrThrow()
    expect((row.result as { status: number }).status).equals(404)
    expect(
      (w.model.messageCalls().at(-1) as Block).messages.at(-1).content.at(-1)
        .text
    ).includes('the server answered 404')
  })

  it('refuses a live-scoring write when it is proposed, so no card is shown', async () => {
    w.model.reply(
      callTools([
        {
          name: 'confirmChange',
          input: {
            method: 'POST',
            path: '/games/gam_1/events',
            body: { plays: [] },
            summary: 'Record a strike'
          }
        }
      ]),
      say('I cannot record plays; the scorekeeper does that.')
    )
    await w.h.request('POST', '/me/tess/messages', {
      text: 'Record a strike for the batter'
    })
    const result = (w.model.messageCalls()[1].messages.at(-1) as Block)
      .content[0]
    expect(result.is_error).equals(true)
    expect(result.content).includes('scoring')
    expect(
      await w.h.db.selectFrom('tess_changes').select('id').execute()
    ).deep.equals([])
    const shown = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages
    expect(shown.flatMap(message => message.changes)).deep.equals([])
  })

  it('checks a stored change against the deny list again before running it', async () => {
    const change = await propose(follow)
    await w.h.db
      .updateTable('tess_changes')
      .set({ path: '/me/account/name' })
      .execute()
    w.model.reply(say('That change was refused.'))
    const confirmed = asTessConfirmation(
      await (await confirm(change.id)).json()
    )
    expect(confirmed.change.status).equals('failed')
  })

  it('keeps the change done when Tess cannot report it', async () => {
    const change = await propose(follow)
    w.model.reply({ status: 529, error: 'overloaded_error' })
    const answer = await confirm(change.id)
    expect(answer.status).equals(200)
    const confirmed = asTessConfirmation(await answer.json())
    expect(confirmed.change.status).equals('done')
    expect(confirmed.messages).deep.equals([])
  })

  it('streams a confirm whose report fails: the change shows done before, and the answer is still the change', async () => {
    const change = await propose(follow)
    w.model.reply({ status: 529, error: 'overloaded_error' })
    const response = await fetch(
      `${w.h.origin}/api/v1/me/tess/changes/${change.id}/confirm`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
          accept: 'text/event-stream'
        }
      }
    )
    const events = await readTurnStream(response)
    expect(events.map(event => event.event)).deep.equals(['stored', 'done'])
    expect(events[0].data.change.status).equals('done')
    const confirmed = asTessConfirmation(events[1].data)
    expect(confirmed.change.status).equals('done')
    expect(confirmed.messages).deep.equals([])
    expect(await followWrites()).equals(1)
  })

  it('stores a change the server gave no answer to as unknown, and says to check it', async () => {
    const id = await proposeChange(
      w.h.db,
      w.userId(101),
      { method: 'PUT', path: '/me/slow-write', summary: 'Save the lineup' },
      new Date()
    )
    const { change, note } = await runChange(
      { ...w.deps(), loopback: { deadlineMs: 200 } },
      w.userId(101),
      w.user(101).credentials,
      id
    )
    // The request reached the server, which may yet write it.
    expect(hanging.length).equals(1)
    expect(change.status).equals('unknown')
    expect(note).includes('gave no answer, so it may or may not have happened')
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select(['status', 'result'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('unknown')
    expect((row.result as { status: number }).status).equals(0)
    // A hold now is refused, and runs nothing again.
    const again = await confirm(id)
    expect(again.status).equals(409)
    expect(((await again.json()) as { message: string }).message).equals(
      UNKNOWN_CHANGE
    )
    expect(hanging.length).equals(1)
  })
  /** Has Tess propose these changes to user 101 in one round, and answers their cards. */
  const proposeAll = async (
    inputs: Array<Record<string, unknown>>
  ): Promise<TessChange[]> => {
    w.model.reply(
      callTools(inputs.map(input => ({ name: 'confirmChange', input }))),
      say('Hold Confirm to do them.')
    )
    const response = await w.h.request('POST', '/me/tess/messages', {
      text: 'Please do them all'
    })
    expect(response.status).equals(200)
    return asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages.flatMap(message => message.changes)
  }
  const confirmAll = async (
    changeIds: unknown,
    gumbo = 101
  ): Promise<Response> =>
    await w.h.request('POST', '/me/tess/changes/confirm', { changeIds }, gumbo)
  const unfollow = {
    method: 'DELETE',
    path: '/me/follows/team/tem_account',
    summary: 'Stop following Demo Hawks'
  }
  const missing = {
    ...follow,
    path: '/me/follows/team/tem_missing',
    summary: 'Follow a team that is not there'
  }

  it('stores a change’s details in their order and shows them on its card', async () => {
    const change = await propose({
      ...follow,
      details: { Team: ' Demo Hawks ', Notify: 'Every game', Since: 'Today' }
    })
    expect(change.details).deep.equals([
      { label: 'Team', value: 'Demo Hawks' },
      { label: 'Notify', value: 'Every game' },
      { label: 'Since', value: 'Today' }
    ])
    // None given, none shown.
    const plain = await propose({ ...follow, summary: 'Follow them again' })
    expect(plain).not.to.have.property('details')
  })

  it('asks again for details that are too many, too long or not words', async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_DETAILS + 1 }, (_, at) => [`L${at}`, 'v'])
    )
    for (const details of [
      tooMany,
      { Opponent: 'x'.repeat(MAX_DETAIL_VALUE + 1) },
      { ['L'.repeat(41)]: 'Demo Eagles' },
      { Innings: 7 },
      { Opponent: '  ' }
    ]) {
      w.model.calls.length = 0
      w.model.reply(
        callTools([{ name: 'confirmChange', input: { ...follow, details } }]),
        say('Let me try that again.')
      )
      await w.h.request('POST', '/me/tess/messages', { text: 'Follow them' })
      const result = (w.model.messageCalls()[1].messages.at(-1) as Block)
        .content[0]
      expect(result.is_error, JSON.stringify(details)).equals(true)
      expect(result.content).includes(`up to ${MAX_DETAILS}`)
    }
    expect(
      await w.h.db.selectFrom('tess_changes').select('id').execute()
    ).deep.equals([])
  })

  it('proposes at most one hold’s changes in a turn, and tells Tess to propose the rest once these are confirmed', async () => {
    const calls = Array.from({ length: MAX_BATCH + 1 }, (_, at) => ({
      name: 'confirmChange',
      input: { ...follow, summary: `Follow Demo Hawks, game ${at + 1}` }
    }))
    // Over two rounds of one turn: the last of the second is one too many.
    w.model.reply(
      callTools(calls.slice(0, MAX_BATCH - 1)),
      callTools(calls.slice(MAX_BATCH - 1)),
      say('Hold Confirm for these, and I will propose the last one then.')
    )
    const response = await w.h.request('POST', '/me/tess/messages', {
      text: 'Follow them for every game'
    })
    expect(response.status).equals(200)
    const results = (w.model.messageCalls()[2].messages.at(-1) as Block)
      .content as Block[]
    expect(results.map(result => result.is_error === true)).deep.equals([
      false,
      true
    ])
    expect(results[1].content).equals(TOO_MANY_CHANGES)
    const changes = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages.flatMap(message => message.changes)
    expect(changes.length).equals(MAX_BATCH)
    // One hold confirms them all.
    w.model.reply(say('Done.'))
    const answer = await confirmAll(changes.map(change => change.id))
    expect(answer.status).equals(200)
    expect(
      asTessConfirmations(await answer.json()).changes.map(
        change => change.status
      )
    ).deep.equals(Array.from({ length: MAX_BATCH }, () => 'done'))
    // The next turn may propose again.
    w.model.calls.length = 0
    expect((await propose(follow)).status).equals('pending')
  })

  it('runs a reply’s changes in the order held, one failing leaving the rest to run, then Tess reports once', async () => {
    const changes = await proposeAll([follow, missing, unfollow])
    expect(changes.map(change => change.status)).deep.equals([
      'pending',
      'pending',
      'pending'
    ])
    w.model.calls.length = 0
    w.model.reply(say('You followed Demo Hawks and then stopped.'))
    const answer = await confirmAll(changes.map(change => change.id))
    expect(answer.status).equals(200)
    const confirmed = asTessConfirmations(await answer.json())
    expect(confirmed.changes.map(change => change.status)).deep.equals([
      'done',
      'failed',
      'done'
    ])
    expect(confirmed.messages.map(message => message.text)).deep.equals([
      'You followed Demo Hawks and then stopped.'
    ])
    // In order: followed, then no longer.
    expect(await followWrites()).equals(2)
    const follows = await w.h.request('GET', '/me/follows')
    expect((await follows.json()) as unknown[]).deep.equals([])
    // One request to the model, told of all three in one message.
    expect(w.model.messageCalls()).length(1)
    const notes = (
      (w.model.messageCalls()[0] as Block).messages.at(-1).content as Block[]
    )
      .map(block => String(block.text))
      .filter(text => text.startsWith('The user confirmed'))
    expect(notes).length(3)
    expect(notes[0]).includes('"Follow Demo Hawks"')
    expect(notes[1]).includes('the server answered 404')
    expect(notes[2]).includes('"Stop following Demo Hawks"')
    // Shown as one reply proposing them, then one report.
    const shown = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages
    expect(shown.map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'assistant'
    ])
    expect(shown[1].changes.map(change => change.status)).deep.equals([
      'done',
      'failed',
      'done'
    ])
    // Done is done.
    expect((await confirmAll([changes[0].id])).status).equals(409)
  })

  it('runs nothing of a batch with another person’s change, one not pending, or one past its time', async () => {
    const [first, second] = await proposeAll([follow, unfollow])
    const theirs = await proposeChange(
      w.h.db,
      w.userId(102),
      { method: 'PUT', path: '/me/follows/team/tem_account', summary: 'Mine' },
      new Date()
    )
    expect((await confirmAll([first.id, theirs])).status).equals(404)
    expect((await confirmAll([first.id, randomUUID()])).status).equals(404)
    expect((await confirmAll([first.id, 'not-a-change'])).status).equals(404)
    expect((await confirmAll([first.id], 102)).status).equals(404)
    expect((await confirmAll([first.id, first.id])).status).equals(400)
    expect((await confirmAll([])).status).equals(400)
    expect(
      (
        await confirmAll(
          Array.from({ length: MAX_BATCH + 1 }, () => randomUUID())
        )
      ).status
    ).equals(400)
    expect(await followWrites()).equals(0)

    await w.h.db
      .updateTable('tess_changes')
      .set({ status: 'failed' })
      .where('id', '=', second.id)
      .execute()
    const settled = await confirmAll([first.id, second.id])
    expect(settled.status).equals(409)
    expect(((await settled.json()) as { message: string }).message).includes(
      'already failed'
    )
    expect(await followWrites()).equals(0)

    await w.h.db
      .updateTable('tess_changes')
      .set({ status: 'pending' })
      .where('id', '=', second.id)
      .execute()
    w.setNow(new Date(Date.now() + CHANGE_TTL_MS + 1000))
    const late = await confirmAll([first.id, second.id])
    expect(late.status).equals(409)
    expect(((await late.json()) as { message: string }).message).includes(
      'expired'
    )
    const rows = await w.h.db
      .selectFrom('tess_changes')
      .select('status')
      .where('user_id', '=', w.userId(101))
      .execute()
    expect(rows.map(row => row.status)).deep.equals(['expired', 'expired'])
    expect(await followWrites()).equals(0)
  })

  it('refuses a batch with a change lost mid-run, and marks it unknown', async () => {
    const [first, second] = await proposeAll([follow, unfollow])
    const started = new Date()
    await w.h.db
      .updateTable('tess_changes')
      .set({ status: 'running', started_at: started })
      .where('id', '=', second.id)
      .execute()
    w.setNow(new Date(started.getTime() + LOST_AFTER_MS + 1000))
    const lost = await confirmAll([first.id, second.id])
    expect(lost.status).equals(409)
    expect(((await lost.json()) as { message: string }).message).equals(
      UNKNOWN_CHANGE
    )
    expect((await confirmAll([second.id])).status).equals(409)
    const row = await w.h.db
      .selectFrom('tess_changes')
      .select('status')
      .where('id', '=', second.id)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('unknown')
    expect(await followWrites()).equals(0)
  })

  it('streams a batch: each change as it ended first, then Tess’s one report', async () => {
    const changes = await proposeAll([follow, unfollow])
    w.model.reply(say('Both done.'))
    const response = await fetch(
      `${w.h.origin}/api/v1/me/tess/changes/confirm`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          changeIds: changes.map(change => change.id),
          clientId: 'm-batch-1'
        })
      }
    )
    const events = (await readTurnStream(response)).filter(
      event => event.event !== 'comment'
    )
    expect(
      events
        .map(event => event.event)
        .filter((name, at, all) => at === 0 || all[at - 1] !== name)
    ).deep.equals(['stored', 'text', 'done'])
    expect(
      (events[0].data.changes as TessChange[]).map(change => [
        change.id,
        change.status
      ])
    ).deep.equals(changes.map(change => [change.id, 'done']))
    expect(events[0].data.messages).deep.equals([])
    const done = asTessConfirmations(events.at(-1)!.data)
    expect(done.changes).deep.equals(events[0].data.changes)
    expect(done.messages.map(message => message.text)).deep.equals([
      'Both done.'
    ])
    // Written once the response has finished.
    const audited = async (): Promise<unknown[]> =>
      await w.h.db
        .selectFrom('audit_log')
        .select(['entity_type', 'entity_id'])
        .where('entity_type', '=', 'tess_change')
        .execute()
    for (let tries = 0; (await audited()).length === 0 && tries < 100; tries++)
      await new Promise(resolve => setTimeout(resolve, 20))
    expect(await audited()).deep.includes({
      entity_type: 'tess_change',
      entity_id: changes.map(change => change.id).join(',')
    })
  })

  it('keeps a batch done when Tess cannot report it', async () => {
    const changes = await proposeAll([follow, unfollow])
    w.model.reply({ status: 529, error: 'overloaded_error' })
    const answer = await confirmAll(changes.map(change => change.id))
    expect(answer.status).equals(200)
    const confirmed = asTessConfirmations(await answer.json())
    expect(confirmed.changes.map(change => change.status)).deep.equals([
      'done',
      'done'
    ])
    expect(confirmed.messages).deep.equals([])
  })
  it('goes on with the batch when a change cannot run after all, and says it did not', async () => {
    const proposed = new Date()
    const path = '/me/follows/team/tem_account'
    const ids = [
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'DELETE', path, summary: 'Stop following Demo Hawks' },
        proposed
      ),
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'PUT', path, summary: 'Follow Demo Hawks' },
        proposed
      )
    ]
    // Checked whole, the first runs, and the second is taken meanwhile.
    const deps = w.deps()
    const ran = await runChanges(
      {
        ...deps,
        loopback: {
          fetch: async (input, init) => {
            await w.h.db
              .updateTable('tess_changes')
              .set({ status: 'failed' })
              .where('id', '=', ids[1])
              .execute()
            return await fetch(input, init)
          }
        }
      },
      w.userId(101),
      w.user(101).credentials,
      ids
    )
    expect(ran.map(({ change }) => change.status)).deep.equals([
      'done',
      'failed'
    ])
    expect(ran[1].note).equals(
      'The change "Follow Demo Hawks" (PUT /me/follows/team/tem_account) did not run: This change is already failed'
    )
  })

  it('runs a batch accepted whole as a whole, though its time passes between its first change and its last', async () => {
    const proposed = new Date()
    const path = '/me/follows/team/tem_account'
    const ids = [
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'DELETE', path, summary: 'Stop following Demo Hawks' },
        proposed
      ),
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'PUT', path, summary: 'Follow Demo Hawks' },
        proposed
      )
    ]
    // Confirmed just in time; any later look at the clock is past the limit.
    const late = new Date(proposed.getTime() + CHANGE_TTL_MS + 1000)
    const times = [new Date(proposed.getTime() + CHANGE_TTL_MS - 1000)]
    const ran = await runChanges(
      { ...w.deps(), now: () => times.shift() ?? late },
      w.userId(101),
      w.user(101).credentials,
      ids
    )
    expect(ran.map(({ change }) => change.status)).deep.equals(['done', 'done'])
    expect(ran[1].note).match(/^The user confirmed the change "Follow/)
    expect(await followWrites()).equals(2)
  })

  it('marks each change of a long batch as starting when it starts, so one running is not shown lost', async () => {
    // The batch was confirmed longer ago than a run can take; its second
    // change starts now, by the real clock.
    const confirmed = new Date(Date.now() - LOST_AFTER_MS - 5000)
    const path = '/me/follows/team/tem_account'
    const ids = [
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'DELETE', path, summary: 'Stop following Demo Hawks' },
        confirmed
      ),
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'PUT', path, summary: 'Follow Demo Hawks' },
        confirmed
      )
    ]
    const times = [confirmed]
    // What a reopened chat is shown while the second change's request is out.
    let shownMidRun: TessChange | undefined
    let requests = 0
    const ran = await runChanges(
      {
        ...w.deps(),
        now: () => times.shift() ?? new Date(),
        loopback: {
          fetch: async (input, init) => {
            if (++requests === 2)
              shownMidRun = (
                await changesById(w.h.db, w.userId(101), [ids[1]])
              ).get(ids[1])
            return await fetch(input, init)
          }
        }
      },
      w.userId(101),
      w.user(101).credentials,
      ids
    )
    expect(shownMidRun?.status).equals('running')
    expect(ran.map(({ change }) => change.status)).deep.equals(['done', 'done'])
    const started = await w.h.db
      .selectFrom('tess_changes')
      .select('started_at')
      .where('id', '=', ids[1])
      .executeTakeFirstOrThrow()
    expect(new Date(started.started_at!).getTime()).greaterThan(
      confirmed.getTime() + LOST_AFTER_MS
    )
  })

  /** Two changes proposed to user 101 now: unfollow, then follow. */
  const proposeTwo = async (): Promise<string[]> => {
    const path = '/me/follows/team/tem_account'
    const proposed = new Date()
    return [
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'DELETE', path, summary: 'Stop following Demo Hawks' },
        proposed
      ),
      await proposeChange(
        w.h.db,
        w.userId(101),
        { method: 'PUT', path, summary: 'Follow Demo Hawks' },
        proposed
      )
    ]
  }
  const statusOf = async (id: string): Promise<string> =>
    (
      await w.h.db
        .selectFrom('tess_changes')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status

  it('stores the last change of a batch as unknown when its run breaks off, and keeps the rest', async () => {
    const ids = await proposeTwo()
    // The first change's request goes out; the second's breaks off once it
    // is running, as a database error would.
    let origins = 0
    const deps = w.deps()
    const ran = await runChanges(
      {
        ...deps,
        origin: () => {
          if (++origins > 1) throw new Error('connection reset')
          return deps.origin()
        }
      },
      w.userId(101),
      w.user(101).credentials,
      ids
    )
    expect(ran.map(({ change }) => change.status)).deep.equals([
      'done',
      'unknown'
    ])
    expect(ran[0].note).match(/^The user confirmed the change "Stop following/)
    expect(ran[1].note).equals(
      `The change "Follow Demo Hawks" (PUT /me/follows/team/tem_account) may or may not have run: ${UNKNOWN_CHANGE}`
    )
    expect(await statusOf(ids[1])).equals('unknown')
  })

  it('stores the last change of a batch as failed when it breaks off before it runs', async () => {
    const ids = await proposeTwo()
    // The batch's read and the first change's go; the second's throws.
    let reads = 0
    const deps = w.deps()
    const db = new Proxy(deps.db, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        const method = value as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          if (key === 'selectFrom' && ++reads > 2)
            throw new Error('connection reset')
          return method.apply(target, args)
        }
      }
    })
    const ran = await runChanges(
      { ...deps, db },
      w.userId(101),
      w.user(101).credentials,
      ids
    )
    expect(ran.map(({ change }) => change.status)).deep.equals([
      'done',
      'failed'
    ])
    expect(ran[1].note).equals(
      'The change "Follow Demo Hawks" (PUT /me/follows/team/tem_account) did not run: something went wrong before it could.'
    )
    expect(await statusOf(ids[1])).equals('failed')
  })
})
