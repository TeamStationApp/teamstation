import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import { asTeamAdultsBody, asTeamPlayersBody } from '../../common/teamMembers'
import { userIdOfGumbo } from '../../common/userId'
import {
  type AccountHarness,
  accountHarness,
  accountTestPicture
} from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { testPasswordParameters } from '../../test/passwordFixtures'
import { callTools, fakeModel, say, TEST_SETTINGS } from '../../test/tessFakes'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { closeInto } from '../admin/people'
import { createEmailCode } from '../auth/emailCodes'
import { createPasswordRecord } from '../auth/passwords'
import { createSession } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { recordExternalId } from '../db/externalIds'
import {
  createRelationshipRequest,
  decideRelationshipRequest
} from '../groups/requests'
import { notifyGrant } from '../invites/grants'
import { inbox } from '../notifications/inbox'
import { titleAndDescription } from '../notifications/requestInformation'
import { teamMemberRoutes } from '../routes/teamMembers'
import { walkUpSongRoutes } from '../routes/walkUpSongs'
import { addAdults, attachEmail } from '../teams/addAdults'
import { addPlayers } from '../teams/addPlayers'
import { teamRoster } from '../teams/teamRoster'
import { runTurn } from '../tess/agent'
import { storeAttachment } from '../tess/attachments'
import { proposeChange } from '../tess/changes'
import { appendMessages, saveContextTokens } from '../tess/conversation'
import { ACCOUNT_DELETED } from '../tess/liveUser'
import { withTurn } from '../tess/turns'
import { deleteAccount, DELETED_NAME } from './deleteAccount'

const ROOT = '/me/account'

describe('deleting an account', function () {
  this.timeout(60000)
  let h: AccountHarness
  let nextId = 7000

  before(async () => {
    h = await accountHarness(undefined, undefined, '127.0.0.1', (app, f) => {
      app.use('/api/v1', teamMemberRoutes(f.db, f.media))
      app.use('/api/v1', walkUpSongRoutes(f.db))
    })
  })
  after(async () => {
    await h?.close()
  })
  beforeEach(async () => {
    await h.resetLimits()
    h.mail.clear()
  })

  /** A player with an address and a password, signed in on a device and a machine. */
  const person = async (
    name: string,
    email: string,
    proof: string
  ): Promise<{
    id: string
    email: string
    session: string
    apiToken: string
  }> => {
    nextId += 1
    const id = userIdOfGumbo(nextId)
    const [first, last] = name.split(' ')
    await insertFixtureUsers(h.db, {
      id: nextId,
      legacyId: `usr_deleted_${nextId}`,
      display_name: name,
      first_name: first,
      last_name: last,
      login_enabled: true,
      avatar_path: `players/${nextId}`,
      password_hash: await createPasswordRecord(
        proof,
        testPasswordParameters,
        id
      )
    })
    await h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: id,
        email,
        is_primary: true,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
    await h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: id,
        team_id: 'tem_account',
        role: 'member',
        is_player: true
      })
      .execute()
    const session = await createSession(h.db, id, 'delete-test')
    const apiToken = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: id,
        label: 'Distributor',
        token_hash: hashToken(apiToken),
        created_at: new Date(),
        expires_at: null
      })
      .execute()
    return { id, email, session: session.token, apiToken }
  }

  const status = async (token: string): Promise<number> =>
    (await h.request('GET', '/auth/me', undefined, token)).status

  const passwordStatus = async (
    email: string,
    clientHash: string
  ): Promise<number> =>
    (await h.request('POST', '/auth/password', { email, clientHash }, null))
      .status

  it('empties the account and every account merged into it', async () => {
    const keptProof = 'c3'.repeat(32)
    const closedProof = 'd4'.repeat(32)
    const kept = await person(
      'Ken Griffey',
      'ken.griffey@example.test',
      keptProof
    )
    const closed = await person(
      'Ken Griffey',
      'junior@example.test',
      closedProof
    )
    const older = await person('Ken Griffey', 'kid@example.test', closedProof)
    await closeInto(h.db, older.id, closed.id)
    await closeInto(h.db, closed.id, kept.id)
    const bystander = await person(
      'Tony Gwynn',
      'tony.gwynn@example.test',
      keptProof
    )
    // A sign-in asked for before the deletion must not finish after it.
    const pending = await createEmailCode(
      h.db,
      'JUNIOR@example.test',
      'login',
      {
        displayName: 'Ken Griffey'
      }
    )

    const deleted = await h.request('DELETE', ROOT, undefined, kept.session)
    expect(deleted.status).equals(204)
    expect(deleted.headers.get('set-cookie')).match(/ts_session=;.*Max-Age=0/)

    const rows = await h.db
      .selectFrom('users')
      .selectAll()
      .where('id', 'in', [kept.id, closed.id, older.id, bystander.id])
      .orderBy('id')
      .execute()
    for (const row of rows.slice(0, 3)) {
      expect(row.display_name).equals(DELETED_NAME)
      expect(row.first_name).equals(DELETED_NAME)
      expect(row.last_name).equals(null)
      expect(row.password_hash).equals(null)
      expect(row.login_enabled).equals(false)
      expect(row.avatar_path).equals(null)
    }
    // The merges themselves stay, so stats still add up under one person.
    expect(rows[1].merged_into).equals(kept.id)
    expect(rows[2].merged_into).equals(closed.id)
    expect(rows[3].display_name).equals('Tony Gwynn')

    const addresses = await h.db
      .selectFrom('user_emails')
      .select('user_id')
      .where('user_id', 'in', [kept.id, closed.id, older.id, bystander.id])
      .execute()
    expect(addresses.map(row => row.user_id)).deep.equals([bystander.id])
    const code = await h.db
      .selectFrom('email_codes')
      .select(['consumed_at', 'display_name'])
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    expect(code.consumed_at).not.equals(null)
    expect(code.display_name).equals(null)

    for (const who of [kept, closed, older]) {
      expect(await status(who.session)).equals(401)
      expect(await status(who.apiToken)).equals(401)
    }
    expect(await status(bystander.session)).equals(200)

    // No address or password reaches any of them any more.
    expect(await passwordStatus(kept.email, keptProof)).equals(401)
    expect(await passwordStatus(closed.email, closedProof)).equals(401)
    expect(await passwordStatus(older.email, closedProof)).equals(401)
    const asked = await h.request(
      'POST',
      '/auth/email-code',
      { email: closed.email },
      null
    )
    expect(asked.status).equals(202)
    const verified = await h.request(
      'POST',
      '/auth/email-code/verify',
      { email: closed.email, code: h.mail.get(closed.email) },
      null
    )
    expect(verified.status).equals(200)
    const fresh = (await verified.json()) as { user: { id: number } }
    expect([kept.id, closed.id, older.id]).not.include(fresh.user.id)

    // A player's place on the team stays, under the deleted name.
    const roster = await teamRoster(h.db, undefined, 'tem_account')
    const names = roster.map(entry => entry.shortName)
    expect(names).include(DELETED_NAME)
    expect(names).not.include('Ken G')
    expect(names).include('Tony G')
  })

  it('refuses a machine token, and a request nobody signed', async () => {
    const someone = await person(
      'Cal Ripken',
      'cal.ripken@example.test',
      'e5'.repeat(32)
    )
    expect(
      (await h.request('DELETE', ROOT, undefined, someone.apiToken)).status
    ).equals(403)
    expect((await h.request('DELETE', ROOT, undefined, null)).status).equals(
      401
    )
    expect(await status(someone.session)).equals(200)
  })

  it('keeps the last node administrator', async () => {
    const admin = await person(
      'Ozzie Smith',
      'ozzie.smith@example.test',
      'f6'.repeat(32)
    )
    await h.db
      .updateTable('users')
      .set({ is_admin: false })
      .where('id', '!=', admin.id)
      .execute()
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', admin.id)
      .execute()
    const refused = await h.request('DELETE', ROOT, undefined, admin.session)
    expect(refused.status).equals(409)
    expect(await status(admin.session)).equals(200)

    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    expect(await deleteAccount(h.db, admin.id)).deep.equals([admin.id])
    const row = await h.db
      .selectFrom('users')
      .select(['is_admin', 'display_name'])
      .where('id', '=', admin.id)
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({ is_admin: false, display_name: DELETED_NAME })
    // Deleted already: nobody is signed in as it to delete it again.
    let again: unknown
    try {
      await deleteAccount(h.db, admin.id)
    } catch (error) {
      again = error
    }
    expect((again as { status?: number })?.status).equals(401)
  })
  it('removes personal details, family links and roles, and cannot be brought back', async () => {
    const proof = 'a7'.repeat(32)
    const player = await person(
      'Roberto Clemente',
      'roberto@example.test',
      proof
    )
    const guardian = await person('Hank Aaron', 'hank@example.test', proof)
    await h.db
      .updateTable('users')
      .set({ bats: 'right', throws: 'right', bats_source: 'manual' })
      .where('id', '=', player.id)
      .execute()
    await h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: guardian.id,
        related_user_id: player.id,
        kind: 'guardian'
      })
      .execute()
    await h.db
      .insertInto('walk_up_songs')
      .values({
        team_id: 'tem_account',
        user_id: player.id,
        provider: 'appleMusic',
        provider_id: '1440857781',
        isrc: null,
        title: 'Centerfield',
        artist: 'John Fogerty',
        album: null,
        artwork_url: null,
        duration_ms: 230000,
        start_ms: 10000,
        end_ms: 25000,
        set_by: player.id
      })
      .execute()
    await h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: player.id,
        scope_type: 'team',
        scope_id: 'tem_account',
        role: 'coach'
      })
      .execute()

    expect(
      (await h.request('DELETE', ROOT, undefined, player.session)).status
    ).equals(204)

    const row = await h.db
      .selectFrom('users')
      .select(['bats', 'throws', 'bats_source', 'disabled_at'])
      .where('id', '=', player.id)
      .executeTakeFirstOrThrow()
    expect([row.bats, row.throws, row.bats_source]).deep.equals([
      null,
      null,
      null
    ])
    expect(row.disabled_at).not.equals(null)
    const left = async (
      table: 'walk_up_songs' | 'scope_roles' | 'user_links'
    ): Promise<number> =>
      (
        await h.db
          .selectFrom(table)
          .select('user_id')
          .where('user_id', 'in', [player.id, guardian.id])
          .execute()
      ).length
    expect(await left('walk_up_songs')).equals(0)
    expect(await left('scope_roles')).equals(0)
    expect(await left('user_links')).equals(0)
    expect(await status(guardian.session)).equals(200)

    // An administrator's import that knows the person gives them no address.
    const attached = await h.db.transaction().execute(
      async trx =>
        await attachEmail(trx, player.id, 'roberto.again@example.test', {
          created: false,
          callerIsAdmin: true
        })
    )
    expect(attached).equals('notAttached')
    // And an address put on the row by any other road still cannot sign in.
    await h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: player.id,
        email: 'roberto.again@example.test',
        is_primary: true,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
    expect(
      (
        await h.request(
          'POST',
          '/auth/email-code',
          { email: 'roberto.again@example.test' },
          null
        )
      ).status
    ).equals(202)
    const verified = await h.request(
      'POST',
      '/auth/email-code/verify',
      {
        email: 'roberto.again@example.test',
        code: h.mail.get('roberto.again@example.test')
      },
      null
    )
    expect(verified.status).equals(401)
  })

  it('removes everything Tess keeps of the person, and nobody else’s', async () => {
    const proof = 'b8'.repeat(32)
    const leaving = await person('Ozzie Smith', 'ozzie@example.test', proof)
    const staying = await person('Lou Brock', 'lou@example.test', proof)
    const tessTables = [
      'tess_conversations',
      'tess_messages',
      'tess_attachments',
      'tess_changes',
      'tess_usage_weeks'
    ] as const
    for (const [n, userId] of [leaving.id, staying.id].entries()) {
      await h.db
        .insertInto('tess_conversations')
        .values({ user_id: userId, summary: 'They asked about the schedule' })
        .execute()
      await h.db
        .insertInto('tess_messages')
        .values({
          user_id: userId,
          role: 'user',
          content: JSON.stringify([{ type: 'text', text: 'When do we play?' }])
        })
        .execute()
      await h.db
        .insertInto('tess_attachments')
        .values({
          id: `00000000-0000-4000-8000-00000000010${n}`,
          user_id: userId,
          name: 'lineup.csv',
          media_type: 'text/csv',
          kind: 'csv',
          data: Buffer.from('name\n')
        })
        .execute()
      await h.db
        .insertInto('tess_changes')
        .values({
          id: `00000000-0000-4000-8000-00000000020${n}`,
          user_id: userId,
          method: 'POST',
          path: '/teams/tem_account/games',
          body: JSON.stringify({ opponent: 'Demo Eagles' }),
          summary: 'Add a game against Demo Eagles',
          expires_at: new Date(Date.now() + 1800000)
        })
        .execute()
      await h.db
        .insertInto('tess_usage_weeks')
        .values({
          user_id: userId,
          week_start: '2026-10-19',
          input_tokens: 5000,
          output_tokens: 700,
          requests: 2
        })
        .execute()
    }
    const left = async (
      table: (typeof tessTables)[number],
      userId: string
    ): Promise<number> =>
      (
        await h.db
          .selectFrom(table)
          .select('user_id')
          .where('user_id', '=', userId)
          .execute()
      ).length

    expect(
      (await h.request('DELETE', ROOT, undefined, leaving.session)).status
    ).equals(204)

    for (const table of tessTables) {
      expect(await left(table, leaving.id), table).equals(0)
      expect(await left(table, staying.id), table).equals(1)
    }
  })

  it('keeps nothing Tess writes after it, from a turn still running or one begun later', async () => {
    const leaving = await person(
      'Willie Stargell',
      'willie@example.test',
      'b9'.repeat(32)
    )
    const tessTables = [
      'tess_conversations',
      'tess_messages',
      'tess_attachments',
      'tess_changes',
      'tess_usage_weeks'
    ] as const
    const kept = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {}
      for (const table of tessTables)
        counts[table] = (
          await h.db
            .selectFrom(table)
            .select('user_id')
            .where('user_id', '=', leaving.id)
            .execute()
        ).length
      return counts
    }
    const none = Object.fromEntries(tessTables.map(table => [table, 0]))
    const refusal = async (promise: Promise<unknown>): Promise<HttpError> => {
      try {
        await promise
      } catch (error) {
        expect(error).instanceOf(HttpError)
        return error as HttpError
      }
      throw new Error('Expected a refusal')
    }
    const model = fakeModel()
    const deps = {
      db: h.db,
      settings: TEST_SETTINGS,
      origin: () => h.origin,
      fetch: model.fetch
    }
    const user = {
      userId: leaving.id,
      isAdmin: false,
      credentials: { authorization: `Bearer ${leaving.session}` }
    }
    // Tess is asked something and looks it up; her answer waits until the
    // account is gone.
    let answer: () => void = () => {}
    const answered = new Promise<void>(resolve => {
      answer = resolve
    })
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me' } }]),
      async () => {
        await answered
        return say('Your next game is on Saturday.')
      }
    )
    const turn = refusal(runTurn(deps, user, { text: 'When do we play?' }))
    while (model.messageCalls().length < 2)
      await new Promise(resolve => setTimeout(resolve, 10))
    expect((await kept()).tess_messages).equals(3)
    expect((await kept()).tess_usage_weeks).equals(1)

    expect(
      (await h.request('DELETE', ROOT, undefined, leaving.session)).status
    ).equals(204)
    expect(await kept()).deep.equals(none)
    answer()
    const stopped = await turn
    expect(stopped.status).equals(410)
    expect(stopped.message).equals(ACCOUNT_DELETED)
    expect(await kept()).deep.equals(none)

    // Nor does anything Tess would write later.
    for (const write of [
      async () => await withTurn(h.db, leaving.id, async () => 'held'),
      async () =>
        await appendMessages(h.db, leaving.id, [
          { role: 'assistant', content: [{ type: 'text', text: 'Saturday.' }] }
        ]),
      async () => {
        await saveContextTokens(h.db, leaving.id, 1200)
      },
      async () =>
        await proposeChange(
          h.db,
          leaving.id,
          {
            method: 'POST',
            path: '/teams/tem_account/games',
            summary: 'Add a game against Demo Eagles'
          },
          new Date()
        ),
      async () =>
        await storeAttachment(h.db, leaving.id, {
          name: 'lineup.csv',
          mediaType: 'text/csv',
          data: Buffer.from('name\n').toString('base64')
        })
    ])
      expect((await refusal(write())).status).equals(410)
    expect(await kept()).deep.equals(none)
  })

  it('keeps the last administrator of a team, and lets a second one go', async () => {
    const proof = 'b8'.repeat(32)
    const first = await person('Willie Mays', 'willie@example.test', proof)
    await h.db
      .insertInto('teams')
      .values({ id: 'tem_solo', name: 'Demo Owls' })
      .execute()
    const admin = async (id: string): Promise<void> => {
      await h.db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: id,
          scope_type: 'team',
          scope_id: 'tem_solo',
          role: 'admin'
        })
        .execute()
    }
    await admin(first.id)
    // Also the only administrator of a second team, both as its admin and as
    // its owner: one refusal names every team, each once.
    await h.db
      .insertInto('teams')
      .values({ id: 'tem_duo', name: 'Demo Larks' })
      .execute()
    await h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: first.id,
        scope_type: 'team',
        scope_id: 'tem_duo',
        role: 'admin'
      })
      .execute()
    await h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: first.id,
        team_id: 'tem_duo',
        role: 'owner',
        is_player: false
      })
      .execute()
    const refused = await h.request('DELETE', ROOT, undefined, first.session)
    expect(refused.status).equals(409)
    expect(((await refused.json()) as { message: string }).message).equals(
      'Add another administrator to Demo Larks and Demo Owls before deleting your account'
    )
    // Nothing was written: still signed in, still the administrator.
    expect(await status(first.session)).equals(200)
    expect(
      await h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('user_id', '=', first.id)
        .execute()
    ).length(2)

    const second = await person('Ernie Banks', 'ernie@example.test', proof)
    await admin(second.id)
    await h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: second.id,
        scope_type: 'team',
        scope_id: 'tem_duo',
        role: 'admin'
      })
      .execute()
    expect(
      (await h.request('DELETE', ROOT, undefined, first.session)).status
    ).equals(204)
    const admins = await h.db
      .selectFrom('scope_roles')
      .select('user_id')
      .where('scope_id', '=', 'tem_solo')
      .execute()
    expect(admins.map(row => row.user_id)).deep.equals([second.id])
    // Still on that roster, no longer its owner.
    const owner = await h.db
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', first.id)
      .where('team_id', '=', 'tem_duo')
      .executeTakeFirstOrThrow()
    expect(owner.role).equals('member')
  })

  it('stays deleted: no lifted suspension, and no import, brings anything back', async () => {
    const proof = 'c9'.repeat(32)
    const gone = await person('Rod Carew', 'rod@example.test', proof)
    const child = await person('Tony Oliva', 'tony@example.test', proof)
    const goneId = { system: 'example', kind: 'person', id: 'deleted_adult' }
    const childId = { system: 'example', kind: 'person', id: 'deleted_child' }
    await h.db.transaction().execute(async trx => {
      await recordExternalId(trx, 'user', gone.id, goneId)
      await recordExternalId(trx, 'user', child.id, childId)
    })
    await h.db
      .insertInto('follows')
      .values({ user_id: gone.id, group_type: 'team', group_id: 'tem_account' })
      .execute()
    // Their own picture, uploaded; and a request they sent somebody.
    expect(
      (
        await h.request(
          'PUT',
          ROOT + '/photo',
          { image: accountTestPicture },
          gone.session
        )
      ).status
    ).equals(200)
    const pictures = (): string[] =>
      [...h.objects.keys()].filter(key =>
        key.includes(`/images/user/${gone.id}/`)
      )
    expect(pictures().length).greaterThan(0)
    const sent = makeId('audit')
    await h.db
      .insertInto('notification_events')
      .values({
        id: sent,
        source_type: 'groupRequest',
        source_id: 'req_deleted',
        revision: 1,
        actor_id: gone.id,
        metadata: { senderGroupName: 'Demo Hawks' },
        created_at: new Date()
      })
      .execute()
    // Through the real paths: a guardian request they sent, and a role they
    // gave somebody. Neither stores their name; both are read with it.
    const asked = await createRelationshipRequest(
      h.db,
      { userId: gone.id, isAdmin: false, scopes: [] },
      {
        terms: {
          kind: 'guardian',
          playerUserId: child.id,
          guardian: { userId: gone.id }
        },
        idempotencyKey: 'deleted-guardian-request'
      }
    )
    expect(asked.status).equals('pending')
    await notifyGrant(h.db, {
      ref: { kind: 'team', id: 'tem_account' },
      userId: child.id,
      added: ['coach'],
      actorId: gone.id
    })
    const stored = async (): Promise<unknown[]> =>
      await h.db
        .selectFrom('notification_events')
        .selectAll()
        .orderBy('id')
        .execute()
    const before = await stored()
    expect(JSON.stringify(before)).not.includes('Rod Carew')
    const childActor = { userId: child.id, isAdmin: false, scopes: [] }
    const read = async (): Promise<string[]> => [
      (
        await titleAndDescription(
          h.db,
          await h.db
            .selectFrom('group_requests')
            .selectAll()
            .where('id', '=', asked.id)
            .executeTakeFirstOrThrow()
        )
      ).title,
      ...(await inbox(h.db, childActor, { history: true })).items
        .filter(item => item.type === 'grant')
        .map(item => item.title)
    ]
    expect(await read()).deep.equals([
      "Rod Carew asks to be Tony O's guardian",
      'Rod Carew added you as Coach of Demo Hawks'
    ])

    expect(
      (await h.request('DELETE', ROOT, undefined, gone.session)).status
    ).equals(204)
    // The pictures go after the answer, which does not wait for storage.
    for (let tries = 0; tries < 50 && pictures().length > 0; tries++)
      await new Promise(resolve => setTimeout(resolve, 20))
    expect(pictures()).deep.equals([])
    // Nothing stored changes: every notification reads their name from
    // `users`, which is "Deleted user" now.
    expect(await stored()).deep.equals(before)
    expect(await read()).deep.equals([
      "Deleted user asks to be Tony O's guardian",
      'Deleted user added you as Coach of Demo Hawks'
    ])
    // The request they sent ended with their account, so accepting it later
    // makes no guardian.
    const request = await h.db
      .selectFrom('group_requests')
      .select('status')
      .where('id', '=', asked.id)
      .executeTakeFirstOrThrow()
    expect(request.status).equals('cancelled')
    const decided = await decideRelationshipRequest(
      h.db,
      { userId: child.id, isAdmin: false, scopes: [] },
      asked.id,
      'accept'
    ).catch(() => undefined)
    expect(decided?.status ?? 'refused').not.equals('accepted')
    expect(
      await h.db
        .selectFrom('user_links')
        .select('id')
        .where('related_user_id', '=', child.id)
        .execute()
    ).length(0)
    expect(
      await h.db
        .selectFrom('follows')
        .select('user_id')
        .where('user_id', '=', gone.id)
        .execute()
    ).length(0)

    // A node administrator cannot lift the suspension deletion implies...
    const nodeAdmin = userIdOfGumbo(101)
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', nodeAdmin)
      .execute()
    let refused: unknown
    try {
      await changeNodeAccount(
        h.db,
        { userId: nodeAdmin, isAdmin: true, scopes: [] },
        gone.id,
        { suspended: false }
      )
    } catch (error) {
      refused = error
    }
    expect((refused as { status?: number })?.status).equals(409)
    // ...and neither can anything that writes the row directly.
    let constrained: unknown
    try {
      await h.db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', gone.id)
        .execute()
    } catch (error) {
      constrained = error
    }
    expect((constrained as { code?: string })?.code).equals('23514')

    // An administrator's import that knows the person by their import id puts
    // back no hands, address, family link or role.
    await addPlayers(
      h.db,
      'tem_account',
      asTeamPlayersBody({
        players: [{ externalId: goneId, bats: 'left', throws: 'left' }]
      }).players
    )
    const adults = await addAdults(
      h.db,
      'tem_account',
      asTeamAdultsBody({
        adults: [
          {
            externalId: goneId,
            email: 'rod.again@example.test',
            guardianOf: [childId],
            staff: true
          }
        ]
      }).adults,
      { userId: nodeAdmin, isAdmin: true }
    )
    const result = adults.results[0] as {
      rolesAdded?: unknown[]
      guardianLinks?: number
      emailNotAttached?: boolean
    }
    expect(result.rolesAdded).deep.equals([])
    expect(result.guardianLinks).equals(0)
    expect(result.emailNotAttached).equals(true)
    const row = await h.db
      .selectFrom('users')
      .select(['bats', 'throws', 'display_name'])
      .where('id', '=', gone.id)
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({
      bats: null,
      throws: null,
      display_name: DELETED_NAME
    })
    // Nor can an adult's import make anybody the deleted player's guardian.
    const guardian = await addAdults(
      h.db,
      'tem_account',
      asTeamAdultsBody({
        adults: [
          {
            externalId: {
              system: 'example',
              kind: 'person',
              id: 'would_be_guardian'
            },
            guardianOf: [goneId]
          }
        ]
      }).adults,
      { userId: nodeAdmin, isAdmin: true }
    )
    expect(
      (guardian.results[0] as { guardiansMissing?: number }).guardiansMissing
    ).equals(1)

    // Whoever runs their old team cannot write a name, hands or face back,
    // and can still keep the team's own jersey number.
    await h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: nodeAdmin,
        scope_type: 'team',
        scope_id: 'tem_account',
        role: 'admin'
      })
      .execute()
    const settings = `/teams/tem_account/players/${gone.id}/settings`
    expect(
      (
        await h.request('PUT', settings, {
          name: { firstName: 'Rod', lastName: 'Carew' }
        })
      ).status
    ).equals(404)
    expect(
      (await h.request('PUT', `/players/${gone.id}/settings`, { bats: 'left' }))
        .status
    ).equals(404)
    expect(
      (
        await h.request('PUT', `/teams/tem_account/players/${gone.id}/avatar`, {
          image: accountTestPicture,
          source: 'upload'
        })
      ).status
    ).equals(404)
    expect(pictures()).deep.equals([])
    expect(
      (
        await h.request(
          'PUT',
          `/teams/tem_account/players/${gone.id}/walk-up-song`,
          {
            provider: 'appleMusic',
            providerId: '1440857781',
            title: 'Centerfield',
            artist: 'John Fogerty',
            durationMs: 230000,
            startMs: 10000,
            endMs: 25000
          }
        )
      ).status
    ).equals(404)
    expect((await h.request('PUT', settings, { jersey: '29' })).status).equals(
      200
    )

    for (const table of ['scope_roles', 'user_links', 'user_emails'] as const)
      expect(
        await h.db
          .selectFrom(table)
          .select('user_id')
          .where('user_id', '=', gone.id)
          .execute(),
        table
      ).length(0)
  })
  it('names them "Deleted user" wherever other people read them, with no stored text to change', async () => {
    const proof = 'd1'.repeat(32)
    const gone = await person('Ken Phelps', 'ken@example.test', proof)
    await h.db
      .updateTable('users')
      .set({ display_name: 'Ken', first_name: 'Ken', last_name: null })
      .where('id', '=', gone.id)
      .execute()
    const other = await person('Freddie Freeman', 'freddie@example.test', proof)
    await notifyGrant(h.db, {
      ref: { kind: 'team', id: 'tem_account' },
      userId: other.id,
      added: ['member'],
      actorId: gone.id
    })
    // A request about them, as the player, written by somebody else.
    const asked = await createRelationshipRequest(
      h.db,
      { userId: other.id, isAdmin: false, scopes: [] },
      {
        terms: {
          kind: 'guardian',
          playerUserId: gone.id,
          guardian: { userId: other.id }
        },
        idempotencyKey: 'whole-names-guardian'
      }
    )
    const stored = async (): Promise<unknown[]> =>
      await h.db
        .selectFrom('notification_events')
        .selectAll()
        .orderBy('id')
        .execute()
    const before = await stored()
    const otherActor = { userId: other.id, isAdmin: false, scopes: [] }
    const read = async (): Promise<string[]> => [
      (
        await titleAndDescription(
          h.db,
          await h.db
            .selectFrom('group_requests')
            .selectAll()
            .where('id', '=', asked.id)
            .executeTakeFirstOrThrow()
        )
      ).title,
      ...(await inbox(h.db, otherActor, { history: true })).items
        .filter(item => item.type === 'grant')
        .map(item => item.title)
    ]
    expect(await read()).deep.equals([
      "Freddie Freeman asks to be Ken's guardian",
      'Ken added you to Demo Hawks'
    ])

    expect(
      (await h.request('DELETE', ROOT, undefined, gone.session)).status
    ).equals(204)
    expect(await stored()).deep.equals(before)
    expect(await read()).deep.equals([
      `Freddie Freeman asks to be ${DELETED_NAME}'s guardian`,
      `${DELETED_NAME} added you to Demo Hawks`
    ])
  })
})
