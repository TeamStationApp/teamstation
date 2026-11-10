import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import {
  type SeededAccount,
  seedFixture,
  type TokensFile
} from '../../../tools/dbLoad/fixture'
import { TEST_AMOUNTS } from '../../../tools/dbLoad/testAmounts'
import { openScratch, type Scratch } from '../../../tools/dbLoad/testSupport'
import type { GameState } from '../../common/scoring/state'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import { teamRoutes } from '../routes/teams'
import { describeAnswer, livePitch, main, pitchFor } from './livePitch'

describe('live-pitch', function () {
  this.timeout(120_000)

  let scratch: Scratch
  let tokens: TokensFile
  let server: Server
  let api = ''
  let dir = ''

  const scorer = (index: number): SeededAccount => {
    const label = tokens.games[index].scorekeeper
    const found = tokens.accounts.find(row => row.label === label)
    if (found == null) throw new Error(`no account ${label}`)
    return found
  }

  before(async function () {
    scratch = await openScratch('livepitch')
    tokens = await seedFixture(scratch.db, {
      runId: 'livepitch',
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
    const app = express()
    app.use(jsonBody)
    app.use(withActor(scratch.db))
    app.use('/api/v1', eventRoutes(scratch.db))
    app.use(
      '/api/v1',
      teamRoutes(scratch.db, {
        mediaRoot: '',
        ffmpegPath: '',
        mediaSecret: 'test',
        publicUrl: 'http://localhost',
        space: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: ''
        }
      })
    )
    app.use(errorHandler)
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => {
        resolve(listening)
      })
    })
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    dir = mkdtempSync(join(tmpdir(), 'teamstation-live-pitch-'))
  })
  after(async function () {
    rmSync(dir, { recursive: true, force: true })
    await new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
    await scratch.drop()
  })

  it('scores one pitch and prints the answer’s keys and edits', async function () {
    const game = tokens.games[0]
    const lines: string[] = []
    const answer = await livePitch({
      api: `${api}/`,
      gameId: game.id,
      token: scorer(0).token,
      print: line => lines.push(line)
    })
    expect(answer.keys).deep.equals([
      'edits',
      'currentPlay',
      'lineupsDigest',
      'playsDigest',
      'priorPlaysDigest',
      'generation'
    ])
    expect(answer.plays).equals(undefined)
    expect(answer.edits!.removes).equals(0)
    expect(answer.posted.playsDigest).match(/^[0-9a-f]{64}$/)
    expect(answer.posted.generation).a('number')
    expect(lines[0]).matches(/^pitch: (ball|called strike)$/)
    expect(lines[1]).equals(`POST ${api}/games/${game.id}/events?answer=edits`)
    expect(lines[2]).equals(`200 answer keys: ${answer.keys.join(', ')}`)
    expect(lines[3]).equals(
      `edits: ${answer.edits!.puts} (${answer.edits!.puts} put, 0 remove)`
    )
    expect(lines[4]).equals(`bytes: ${answer.bytes}`)
    expect(lines[5]).matches(/^read as: \{"playsDigest":/)
  })

  it('reads an answer of every play, as a server from before edits gives', async function () {
    const game = tokens.games[1]
    // Every post asks for no answer, so every play comes back, as the base
    // server answers every post.
    const whole = (async (url: string, init?: RequestInit) =>
      await fetch(
        init?.method === 'POST' ? url.replace('?answer=edits', '') : url,
        init
      )) as typeof fetch
    const lines: string[] = []
    const answer = await livePitch({
      api,
      gameId: game.id,
      token: scorer(1).token,
      fetch: whole,
      print: line => lines.push(line)
    })
    expect(answer.keys).includes('plays')
    expect(answer.edits).equals(undefined)
    expect(answer.plays).a('number')
    expect(lines).includes(`plays: ${answer.plays}`)
    expect(answer.posted.playsDigest).match(/^[0-9a-f]{64}$/)
  })

  it('runs as a command with a token file, and fails on a post the server refuses', async function () {
    const game = tokens.games[2]
    const file = join(dir, 'token')
    writeFileSync(file, `${scorer(2).token}\n`)
    const printed: unknown[] = []
    const log = console.log
    console.log = (line: unknown) => {
      printed.push(line)
    }
    try {
      await main(['--api', api, '--game', game.id, '--token-file', file])
    } finally {
      console.log = log
    }
    expect(printed).includes(`POST ${api}/games/${game.id}/events?answer=edits`)
    let usage: unknown
    await main(['--api', api]).catch((error: unknown) => {
      usage = error
    })
    expect(String(usage)).includes('Usage: npm run live-pitch')

    const refusing = (async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ code: 'internal', message: 'down' }), {
            status: 500
          })
        : await fetch(url, init)) as typeof fetch
    const lines: string[] = []
    let refused: unknown
    await livePitch({
      api,
      gameId: game.id,
      token: scorer(2).token,
      fetch: refusing,
      print: line => lines.push(line)
    }).catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).includes('The post answered 500')
    expect(lines).includes('500 {"code":"internal","message":"down"}')
  })

  it('throws the pitch that ends a full count', function () {
    const at = (strikes: number | undefined): GameState =>
      ({
        liveData: {
          plays: {
            currentPlay:
              strikes === undefined ? null : { count: { balls: 3, strikes } }
          }
        }
      }) as unknown as GameState
    expect(pitchFor(at(2))).equals('C')
    expect(pitchFor(at(1))).equals('B')
    expect(pitchFor(at(undefined))).equals('B')
    expect(describeAnswer('{"plays":[1,2],"currentPlay":null}')).deep.equals({
      keys: ['plays', 'currentPlay'],
      plays: 2,
      bytes: 34
    })
    expect(describeAnswer('{"ok":true}')).deep.equals({
      keys: ['ok'],
      bytes: 11
    })
  })
})
