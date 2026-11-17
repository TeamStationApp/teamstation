import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import {
  callTools,
  readTurnStream,
  say,
  type TessWorld,
  tessWorld
} from '../../test/tessFakes'
import { loadConversation } from './conversation'
import { DIRECTORY_MAP, MAP_FIRST, sourceBrowser } from './sourceTools'

describe('Tess source access over HTTP', function () {
  this.timeout(60000)
  let w: TessWorld
  before(async () => {
    w = await tessWorld()
  })
  after(async () => {
    await w?.close()
  })

  it('lets a non-admin read the map then targeted source, streams labels and resets next turn', async () => {
    expect(w.user(101).isAdmin).equals(false)
    const call = (
      id: string,
      name: string,
      input: unknown
    ): ReturnType<typeof callTools> => callTools([{ id, name, input }])
    w.model.reply(
      call('premature', 'source_search', {
        path: 'src',
        text: 'MAX_TOOL_ROUNDS'
      }),
      call('map', 'source_read_file', { path: DIRECTORY_MAP }),
      call('find', 'source_search', {
        path: 'src/server/tess/agent.ts',
        text: 'MAX_TOOL_ROUNDS'
      }),
      call('read', 'source_read_file', {
        path: 'src/server/tess/agent.ts',
        startLine: 40
      }),
      call('escape', 'source_read_file', { path: 'src/../package.json' }),
      say(
        'In src/server/tess/agent.ts, MAX_TOOL_ROUNDS is 10. Tess closes the tool round when that limit is reached.'
      )
    )
    const response = await fetch(`${w.h.origin}/api/v1/me/tess/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.h.tokens.get(101)!}`,
        accept: 'text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: 'How many tool rounds can Tess use? Please cite the source.'
      })
    })
    expect(response.status).equals(200)
    const events = await readTurnStream(response)
    const steps = events.filter(e => e.event === 'step').map(e => e.data)
    expect(steps).deep.includes({
      id: 'map',
      label: 'Reading TeamStation source',
      status: 'done'
    })
    expect(steps).deep.includes({
      id: 'premature',
      label: 'Searching TeamStation source',
      status: 'failed'
    })
    expect(steps).deep.includes({
      id: 'escape',
      label: 'Reading TeamStation source',
      status: 'failed'
    })
    const blocks = (
      await loadConversation(w.h.db, w.userId(101))
    ).messages.flatMap(m => m.content)
    const results = blocks.filter(b => b.type === 'tool_result')
    expect(results.find(b => b.tool_use_id === 'premature')?.content).equals(
      MAP_FIRST
    )
    expect(results.find(b => b.tool_use_id === 'map')?.content).includes(
      'Source directory map'
    )
    expect(results.find(b => b.tool_use_id === 'find')?.content).match(
      /src\/server\/tess\/agent.ts:\d+: export const MAX_TOOL_ROUNDS = 10/
    )
    expect(results.find(b => b.tool_use_id === 'read')?.content).includes(
      'MAX_TOOL_ROUNDS = 10'
    )
    expect(results.find(b => b.tool_use_id === 'escape')?.is_error).equals(true)
    expect(
      await w.h.db.selectFrom('tess_changes').selectAll().execute()
    ).length(0)

    w.model.reply(
      call('next-turn', 'source_read_file', {
        path: 'src/server/tess/agent.ts'
      }),
      say('I need to consult the map again.')
    )
    const client = new TeamStationClient({
      baseUrl: `${w.h.origin}/api/v1`,
      token: w.h.tokens.get(101)
    })
    await client.sendTessMessage('Show the source again.')
    const next = (await loadConversation(w.h.db, w.userId(101))).messages
      .flatMap(m => m.content)
      .filter(b => b.type === 'tool_result')
    expect(next.find(b => b.tool_use_id === 'next-turn')?.content).equals(
      MAP_FIRST
    )
    expect(w.model.pending()).equals(0)
  })
})

describe('Tess source special files', function () {
  this.timeout(20000)
  it('refuses a FIFO without blocking and skips it in listings and search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tess-source-pipe-'))
    try {
      await writeFile(join(root, 'DIRECTORY_MAP.md'), '# Source map')
      execFileSync('mkfifo', [join(root, 'pipe')])
      const browser = sourceBrowser(root)
      browser.acceptMapResult(
        await browser.run('source_read_file', { path: DIRECTORY_MAP })
      )
      expect(
        (await browser.run('source_read_file', { path: 'src/pipe' })).is_error
      ).equals(true)
      expect(
        (await browser.run('source_list_directory', { path: 'src' })).content
      ).not.includes('pipe')
      const searched = await browser.run('source_search', {
        path: 'src',
        text: 'absent'
      })
      expect(searched.is_error).not.equals(true)
      expect(searched.content).includes('[No matches.]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
