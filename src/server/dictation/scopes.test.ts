import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import type { HttpError } from '../../common/errors'
import { toolSchema } from '../../common/scoring/actions'
import { rosterToolSchema } from '../../common/scoring/rosterCommands'
import { userIdOfGumbo } from '../../common/userId'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { dictationScopes, SCOPES } from './scopes'

// The Tess scope never reads the database; one that tried would throw here.
const db = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database was read')
    }
  }
) as Kysely<Database>

describe('dictation scopes', function () {
  it('registers scoring, the roster sheet and Tess', function () {
    expect([...SCOPES.keys()]).deep.equals(['scoring', 'roster', 'tess'])
  })

  it('lets a person signed in themselves talk to Tess, about nothing in particular', async function () {
    const tess = dictationScopes({ tess: true }).get('tess')!
    expect(tess.tools).deep.equals([])
    expect(tess.rosterTools).equals(undefined)
    expect(tess.transcriptOnly).equals(true)
    // Resolving is the admission; the route refuses on a throw.
    for (const actor of [
      { userId: userIdOfGumbo(1), isAdmin: false, scopes: [] },
      { userId: userIdOfGumbo(2), isAdmin: true, scopes: [], sessionId: 's1' }
    ])
      await tess.authorise(db, actor, {})
  })

  it('refuses Tess to a machine token, to Tess herself, and on a server without her, as /me/tess does', async function () {
    const refusal = async (tess: boolean, actor: Actor): Promise<HttpError> => {
      try {
        await dictationScopes({ tess }).get('tess')!.authorise(db, actor, {})
      } catch (error) {
        return error as HttpError
      }
      return expect.fail('Tess was admitted')
    }
    const token = await refusal(true, {
      userId: userIdOfGumbo(1),
      isAdmin: false,
      scopes: ['read'],
      apiTokenId: 'tok_1'
    })
    expect(token.status).equals(403)
    expect(token.message).equals('Sign in to talk to Tess')
    // The person's own session, but sent by Tess's tools.
    const own = await refusal(true, {
      userId: userIdOfGumbo(1),
      isAdmin: false,
      scopes: [],
      sessionId: 's1',
      viaTess: true
    })
    expect(own.status).equals(403)
    // The person's own API key: the person, but not here themselves.
    const key = await refusal(true, {
      userId: userIdOfGumbo(1),
      isAdmin: false,
      scopes: [],
      apiKey: { id: 'uak_1', permissions: new Set(['gameEvents:write']) }
    })
    expect(key.status).equals(403)
    const off = await refusal(false, {
      userId: userIdOfGumbo(1),
      isAdmin: false,
      scopes: []
    })
    expect(off.status).equals(503)
    // The scopes a server without Tess offers.
    expect(SCOPES.get('tess')).not.equals(undefined)
    expect(
      (
        await refusal(false, {
          userId: userIdOfGumbo(2),
          isAdmin: true,
          scopes: []
        })
      ).status
    ).equals(503)
  })

  it('leaves scoring and the roster sheet asking the LLM, with their tools', function () {
    const scoring = SCOPES.get('scoring')!
    expect(scoring.transcriptOnly).equals(undefined)
    expect(scoring.tools).deep.equals(
      toolSchema().filter(tool => tool.name !== 'lineup')
    )
    expect(scoring.rosterTools).deep.equals(rosterToolSchema())
    const roster = SCOPES.get('roster')!
    expect(roster.transcriptOnly).equals(undefined)
    expect(roster.tools).deep.equals([])
    expect(roster.rosterTools).deep.equals(rosterToolSchema())
  })
})
