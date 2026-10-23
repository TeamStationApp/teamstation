import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import { toolSchema } from '../../common/scoring/actions'
import { rosterToolSchema } from '../../common/scoring/rosterCommands'
import { userIdOfGumbo } from '../../common/userId'
import type { Database } from '../db/database'
import { SCOPES } from './scopes'

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

  it('lets any signed-in actor talk to Tess, about nothing in particular', async function () {
    const tess = SCOPES.get('tess')!
    expect(tess.tools).deep.equals([])
    expect(tess.rosterTools).equals(undefined)
    expect(tess.transcriptOnly).equals(true)
    // Resolving is the admission; the route refuses on a throw.
    for (const actor of [
      { userId: userIdOfGumbo(1), isAdmin: false, scopes: [] },
      { userId: userIdOfGumbo(2), isAdmin: true, scopes: [] }
    ])
      await tess.authorise(db, actor, {})
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
