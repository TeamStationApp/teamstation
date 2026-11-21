import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { FIXTURE_MAP, sourceIndexFixture } from '../../test/sourceIndexFixture'
import {
  callTools,
  readTurnStream,
  say,
  type TessWorld,
  tessWorld
} from '../../test/tessFakes'
import { loadConversation } from './conversation'
import { SOURCE_UNAVAILABLE } from './sourceTools'

describe('Tess indexed source over HTTP', function () {
  this.timeout(60000)
  let f: ReturnType<typeof sourceIndexFixture>, w: TessWorld
  before(async () => {
    f = sourceIndexFixture()
    f.build()
    w = await tessWorld({ sourceIndex: f.index })
  })
  after(async () => {
    await w?.close()
    f?.close()
  })
  it('lets an ordinary user search immediately, streams labels and supplies the cached map', async () => {
    expect(w.user(101).isAdmin).equals(false)
    w.model.reply(
      callTools([
        {
          id: 'search',
          name: 'source_search',
          input: { path: 'src/server/tess/agent.ts', text: 'MAX_TOOL_ROUNDS' }
        }
      ]),
      callTools([
        {
          id: 'definition',
          name: 'source_find_definition',
          input: { name: 'MAX_TOOL_ROUNDS' }
        },
        {
          id: 'outline',
          name: 'source_outline',
          input: { path: 'src/server/tess' }
        }
      ]),
      say('src/server/tess/agent.ts:2 defines MAX_TOOL_ROUNDS = 20.')
    )
    const response = await fetch(`${w.h.origin}/api/v1/me/tess/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.h.tokens.get(101)!}`,
        accept: 'text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: 'How many tool rounds can Tess use?' })
    })
    expect(response.status).equals(200)
    const events = await readTurnStream(response)
    const steps = events
      .filter(event => event.event === 'step')
      .map(event => event.data)
    for (const [id, label] of [
      ['search', 'Searching TeamStation source'],
      ['definition', 'Finding a definition'],
      ['outline', 'Outlining source']
    ])
      expect(steps).deep.includes({ id, label, status: 'done' })
    const first = w.model.messageCalls()[0]
    expect(first.system[1].text)
      .includes(FIXTURE_MAP)
      .and.includes('fixture-release')
    expect(first.system[2].text).not.includes(FIXTURE_MAP)
    const results = (await loadConversation(w.h.db, w.userId(101))).messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'tool_result')
    expect(results.every(result => result.is_error !== true)).equals(true)
    expect(
      results.find(result => result.tool_use_id === 'search')!.content
    ).includes('MAX_TOOL_ROUNDS = 20')
    expect(
      await w.h.db.selectFrom('tess_changes').selectAll().execute()
    ).length(0)
    w.model.reply(
      callTools([
        {
          name: 'source_read_file',
          input: { path: 'src/server/tess/agent.ts' }
        }
      ]),
      say('Still 20.')
    )
    const client = new TeamStationClient({
      baseUrl: `${w.h.origin}/api/v1`,
      token: w.h.tokens.get(101)
    })
    await client.sendTessMessage('Show it again.')
    expect(
      w.model.messageCalls().at(-1)!.messages.at(-1).content[0].content
    ).includes('MAX_TOOL_ROUNDS = 20')
  })
  it('keeps authenticated API reads available through HTTP when the source index is missing', async () => {
    const missing = await tessWorld({ sourceIndex: f.index + '.missing' })
    try {
      missing.model.reply(
        callTools([{ name: 'source_outline', input: { path: 'src/server' } }]),
        callTools([{ name: 'api_get', input: { path: '/me/roles' } }]),
        say('Source is unavailable; account roles are available.')
      )
      const client = new TeamStationClient({
        baseUrl: `${missing.h.origin}/api/v1`,
        token: missing.h.tokens.get(101)
      })
      await client.sendTessMessage('Explain implementation and my roles.')
      const calls = missing.model.messageCalls()
      expect(calls[1].messages.at(-1).content[0]).includes({
        content: SOURCE_UNAVAILABLE,
        is_error: true
      })
      expect(calls[2].messages.at(-1).content[0].content).match(/^HTTP 200/)
      if (process.env.TS_TESS_BOUNDARY_LOG === '1')
        console.log(
          JSON.stringify({
            request: 'POST /api/v1/me/tess/messages',
            source_outline: SOURCE_UNAVAILABLE,
            api_get: 'HTTP 200',
            finalAnswer: 'Source is unavailable; account roles are available.'
          })
        )
    } finally {
      await missing.close()
    }
  })
})
