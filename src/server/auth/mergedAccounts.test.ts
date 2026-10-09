import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { testPasswordParameters } from '../../test/passwordFixtures'
import { closeInto, openRowOf } from '../admin/people'
import { liveGrant, oauthHash } from '../oauth/adapter'
import { findUserByEmail } from './emails'
import { createPasswordRecord } from './passwords'
import { actorForToken, createSession } from './sessions'
import { hashToken, makeToken } from './tokens'

/** Everything one account can be signed in with. */
interface Credentials {
  session: string
  apiToken: string
  grant: string
}

describe('signing in to merged accounts', function () {
  this.timeout(60000)
  let h: AccountHarness
  let nextId = 5000

  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })
  beforeEach(async () => {
    await h.resetLimits()
    h.mail.clear()
  })

  /** A person with one address, signed in on a device, a machine and an AI. */
  const person = async (
    name: string,
    email: string,
    proof?: string
  ): Promise<{ id: number; email: string; signedIn: Credentials }> => {
    nextId += 1
    const id = nextId
    await h.db
      .insertInto('users')
      .values({
        id,
        legacyId: `usr_merged_${id}`,
        display_name: name,
        login_enabled: true,
        password_hash:
          proof == null
            ? null
            : await createPasswordRecord(proof, testPasswordParameters, id)
      })
      .execute()
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
    return { id, email, signedIn: await signIn(id) }
  }

  const signIn = async (id: number): Promise<Credentials> => {
    const session = await createSession(h.db, id, 'merge-test')
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
    const grant = makeToken()
    const grantHash = oauthHash(grant)
    await sql`insert into oauth_grant_sessions (grant_hash, client_id, user_id, session_id)
      values (${grantHash}, 'assistant', ${id}, ${session.sessionId})`.execute(
      h.db
    )
    await sql`insert into oauth_records (model, id_hash, payload, grant_hash) values
      ('Grant', ${grantHash}, 'sealed', null),
      ('AccessToken', ${oauthHash(makeToken())}, 'sealed', ${grantHash}),
      ('RefreshToken', ${oauthHash(makeToken())}, 'sealed', ${grantHash})`.execute(
      h.db
    )
    return { session: session.token, apiToken, grant }
  }

  const oauthRecords = async (grant: string): Promise<number> => {
    const grantHash = oauthHash(grant)
    const rows = await sql<{ count: string }>`select count(*)::text as count
      from oauth_records where grant_hash = ${grantHash} or id_hash = ${grantHash}`.execute(
      h.db
    )
    return Number(rows.rows[0]?.count)
  }

  const me = async (
    token: string
  ): Promise<{ status: number; body: unknown }> => {
    const response = await h.request('GET', '/auth/me', undefined, token)
    return { status: response.status, body: await response.json() }
  }

  /** What the server says to a session that has simply run out. */
  const expiredAnswer = async (): Promise<{
    status: number
    body: unknown
  }> => {
    const expired = await createSession(h.db, 101, 'merge-test', { days: -1 })
    return await me(expired.token)
  }

  const codeSignIn = async (
    email: string
  ): Promise<{ status: number; userId?: number }> => {
    const asked = await h.request('POST', '/auth/email-code', { email }, null)
    expect(asked.status).equals(202)
    const code = h.mail.get(email)
    expect(code, `a code mailed to ${email}`).not.equals(undefined)
    const verified = await h.request(
      'POST',
      '/auth/email-code/verify',
      { email, code },
      null
    )
    if (verified.status !== 200) return { status: verified.status }
    const session = (await verified.json()) as {
      token: string
      user: { id: number }
    }
    // The session it hands back is good, and is the account it named.
    const who = await me(session.token)
    expect(who.status).equals(200)
    expect((who.body as { id: number }).id).equals(session.user.id)
    return { status: 200, userId: session.user.id }
  }

  it('signs the merged account out of everything and leaves the kept one alone', async () => {
    const kept = await person('Mookie Betts', 'mookie.betts@example.test')
    const closed = await person('Mookie Betts', 'mookie@example.test')
    expect((await me(closed.signedIn.session)).status).equals(200)
    expect((await me(closed.signedIn.apiToken)).status).equals(200)

    expect((await closeInto(h.db, closed.id, kept.id)).closed).equals(true)

    const sessions = await h.db
      .selectFrom('auth_sessions')
      .select(['user_id', 'revoked_at', 'last_used_at'])
      .where('user_id', 'in', [kept.id, closed.id])
      .execute()
    for (const row of sessions) {
      if (row.user_id === closed.id) expect(row.revoked_at).not.equals(null)
      else expect(row.revoked_at).equals(null)
    }
    // Kept, not deleted: when it was last used still answers "has this
    // account ever been used".
    expect(sessions.some(row => row.user_id === closed.id)).equals(true)
    const tokens = await h.db
      .selectFrom('api_tokens')
      .select(['user_id', 'revoked_at'])
      .where('user_id', 'in', [kept.id, closed.id])
      .execute()
    expect(tokens).length(2)
    for (const row of tokens) {
      if (row.user_id === closed.id) expect(row.revoked_at).not.equals(null)
      else expect(row.revoked_at).equals(null)
    }
    expect(await oauthRecords(closed.signedIn.grant)).equals(0)
    expect(await oauthRecords(kept.signedIn.grant)).equals(3)
    expect(await liveGrant(h.db, oauthHash(kept.signedIn.grant))).equals(true)

    // Every device signed in as the closed account is told what an expired
    // session is told, so every client's "signed out" handling applies.
    const expired = await expiredAnswer()
    expect(expired.status).equals(401)
    expect(await me(closed.signedIn.session)).deep.equals(expired)
    expect(await me(closed.signedIn.apiToken)).deep.equals(expired)
    expect((await me(kept.signedIn.session)).status).equals(200)
    expect((await me(kept.signedIn.apiToken)).status).equals(200)
  })

  it('refuses an account merged before merges signed anybody out', async () => {
    const kept = await person('Freddie Freeman', 'freddie.freeman@example.test')
    const closed = await person('Freddie Freeman', 'freddie@example.test')
    // Closed by hand, as rows were before: nothing revoked.
    await h.db
      .updateTable('users')
      .set({ merged_into: kept.id })
      .where('id', '=', closed.id)
      .execute()

    const expired = await expiredAnswer()
    expect(await me(closed.signedIn.session)).deep.equals(expired)
    expect(await me(closed.signedIn.apiToken)).deep.equals(expired)
    expect(await actorForToken(h.db, closed.signedIn.session)).equals(undefined)
    expect(await actorForToken(h.db, closed.signedIn.apiToken)).equals(
      undefined
    )
    expect(await liveGrant(h.db, oauthHash(closed.signedIn.grant))).equals(
      false
    )
    expect((await me(kept.signedIn.session)).status).equals(200)
  })

  it('signs in to the kept account with either address, by code', async () => {
    const kept = await person('Shohei Ohtani', 'shohei.ohtani@example.test')
    const closed = await person('Shohei Ohtani', 'shohei@example.test')
    await closeInto(h.db, closed.id, kept.id)

    expect(await codeSignIn(closed.email)).deep.equals({
      status: 200,
      userId: kept.id
    })
    expect(await codeSignIn(kept.email)).deep.equals({
      status: 200,
      userId: kept.id
    })
    // Nothing was moved onto the kept account to make that work.
    const addresses = await h.db
      .selectFrom('user_emails')
      .select(['user_id'])
      .where('email', '=', closed.email)
      .executeTakeFirstOrThrow()
    expect(addresses.user_id).equals(closed.id)
  })

  it('signs in with the kept account’s password through the merged address', async () => {
    const keptProof = 'a1'.repeat(32)
    const closedProof = 'b2'.repeat(32)
    const kept = await person(
      'Aaron Judge',
      'aaron.judge@example.test',
      keptProof
    )
    const closed = await person(
      'Aaron Judge',
      'aaron@example.test',
      closedProof
    )
    await closeInto(h.db, closed.id, kept.id)

    const password = async (
      email: string,
      clientHash: string
    ): Promise<{ status: number; userId?: number }> => {
      const response = await h.request(
        'POST',
        '/auth/password',
        { email, clientHash },
        null
      )
      if (response.status !== 200) return { status: response.status }
      const session = (await response.json()) as { user: { id: number } }
      return { status: 200, userId: session.user.id }
    }
    expect(await password(closed.email, keptProof)).deep.equals({
      status: 200,
      userId: kept.id
    })
    expect(await password(kept.email, keptProof)).deep.equals({
      status: 200,
      userId: kept.id
    })
    expect((await password(closed.email, closedProof)).status).equals(401)

    // The parameters for the merged address are the kept account's.
    const parameters = async (email: string): Promise<unknown> =>
      await (
        await h.request('POST', '/auth/password/parameters', { email }, null)
      ).json()
    expect(await parameters(closed.email)).deep.equals(
      await parameters(kept.email)
    )

    // Whether it may sign in is the kept account's to say.
    await h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', kept.id)
      .execute()
    expect((await password(closed.email, keptProof)).status).equals(401)
  })

  it('follows a chain of merges to the open account', async () => {
    const first = await person('Juan Soto', 'juan.soto@example.test')
    const middle = await person('Juan Soto', 'juan@example.test')
    const last = await person('Juan Soto', 'soto@example.test')
    await closeInto(h.db, middle.id, first.id)
    await closeInto(h.db, last.id, middle.id)

    expect(await openRowOf(h.db, last.id)).equals(first.id)
    expect(await codeSignIn(last.email)).deep.equals({
      status: 200,
      userId: first.id
    })
    const found = await findUserByEmail(h.db, last.email.toUpperCase())
    expect(found?.id).equals(first.id)
    expect(found?.email).equals(last.email)
    expect(found?.displayName).equals('Juan Soto')
  })

  it('finds nobody when the chain reaches no open account', async () => {
    const one = await person('Bobby Witt', 'bobby.witt@example.test')
    const other = await person('Bobby Witt', 'bobby@example.test')
    await h.db
      .updateTable('users')
      .set({ merged_into: other.id })
      .where('id', '=', one.id)
      .execute()
    await h.db
      .updateTable('users')
      .set({ merged_into: one.id })
      .where('id', '=', other.id)
      .execute()
    expect(await openRowOf(h.db, one.id)).equals(undefined)
    expect(await findUserByEmail(h.db, one.email)).equals(undefined)
    expect(await openRowOf(h.db, 999999999)).equals(undefined)
    expect(await findUserByEmail(h.db, 'nobody@example.test')).equals(undefined)
    expect(await findUserByEmail(h.db, '  ')).equals(undefined)
  })

  it('signs in to the merged account again once the merge is undone', async () => {
    const kept = await person('Corey Seager', 'corey.seager@example.test')
    const closed = await person('Kyle Seager', 'kyle.seager@example.test')
    await closeInto(h.db, closed.id, kept.id)
    expect((await codeSignIn(closed.email)).userId).equals(kept.id)

    // As `repair-people` opens a group back up.
    await h.db
      .updateTable('users')
      .set({ merged_into: null, updated_at: new Date() })
      .where('id', '=', closed.id)
      .execute()

    expect(await codeSignIn(closed.email)).deep.equals({
      status: 200,
      userId: closed.id
    })
    expect(await codeSignIn(kept.email)).deep.equals({
      status: 200,
      userId: kept.id
    })
    // What the merge signed out stays signed out.
    expect((await me(closed.signedIn.session)).status).equals(401)
    expect((await me(closed.signedIn.apiToken)).status).equals(401)
  })

  it('answers a code request for a merged address as it answers an unknown one', async () => {
    const kept = await person(
      'Gunnar Henderson',
      'gunnar.henderson@example.test'
    )
    const closed = await person('Gunnar Henderson', 'gunnar@example.test')
    await closeInto(h.db, closed.id, kept.id)

    const ask = async (
      email: string
    ): Promise<{ status: number; keys: string[]; sent: unknown }> => {
      const response = await h.request(
        'POST',
        '/auth/email-code',
        { email },
        null
      )
      const body = (await response.json()) as Record<string, unknown>
      return {
        status: response.status,
        keys: Object.keys(body).sort(),
        sent: body.sent
      }
    }
    const unknown = await ask('nobody.here@example.test')
    expect(await ask(closed.email)).deep.equals(unknown)
    expect(await ask(kept.email)).deep.equals(unknown)
    expect(h.mail.has('nobody.here@example.test')).equals(false)
    // The code goes to the address that was typed.
    expect(h.mail.has(closed.email)).equals(true)
  })
})
