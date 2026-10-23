import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import type { Response as ExpressResponse } from 'express'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  asTessConfirmation,
  asTessConversation,
  type TessChange
} from '../../common/api'
import { callTools, say, type TessWorld, tessWorld } from '../../test/tessFakes'
import {
  CHANGE_TTL_MS,
  LOST_AFTER_MS,
  proposeChange,
  runChange,
  UNKNOWN_CHANGE
} from './changes'

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
})
