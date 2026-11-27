import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import {
  answered,
  apiBase,
  byLabel,
  byLabelStart,
  exactly,
  jevOf,
  MILES_FROM_SAN_DIEGO,
  Overtaken,
  ownRows,
  proveLog,
  ringProblems,
  rowCity,
  rowKind,
  rowName,
  searchFrameLog,
  type SearchRow,
  searchSpec,
  serverLogCount,
  within
} from './searchRig'

const row = (label: string, ...lines: string[]): SearchRow => ({
  label: `Open ${label}`,
  text: [label, ...lines].join('\n'),
  follow: null
})

const context = (stack: Record<string, unknown>, runDir = ''): E2eContext =>
  ({
    stack: { origin: 'https://e2e-01.example.test', ...stack },
    artifact: (name: string) => join(runDir, name)
  }) as unknown as E2eContext

describe('the search rig', function () {
  it('selects by a whole or a starting label, and matches text exactly', function () {
    expect(byLabel('Open "Hawks"')).equals('[aria-label="Open \\"Hawks\\""]')
    expect(byLabelStart('Choose Corbin')).equals(
      '[aria-label^="Choose Corbin"]'
    )
    expect(exactly('No key is set. (Yet?)')).equals(
      'No key is set[.] [(]Yet[?][)]'
    )
    expect(exactly('a]b\\c^d')).equals('a\\]b\\\\c\\^d')
    for (const text of [
      'No key is set. (Yet?)',
      'Choose Corbin [x] $1 a|b {2}',
      'a]b\\c^d'
    ])
      expect(new RegExp(`^${exactly(text)}$`).test(text), text).equals(true)
    expect(new RegExp(`^${exactly('a.c')}$`).test('abc')).equals(false)
  })

  it('reads a row’s world, name, kind and city', function () {
    const rows = [
      row('Demo Hawks 1a2b', 'Team', 'San Diego, CA'),
      row('Demo Hawks 9f9f', 'Team', 'San Diego, CA'),
      row('LaTroy Hawkins', 'Person', 'Ridge Hawks 1a2b')
    ]
    expect(ownRows(rows, '1a2b').map(rowName)).deep.equals(['Demo Hawks 1a2b'])
    expect(rowKind(rows[2])).equals('Person')
    expect(rowKind(row('x'))).equals(undefined)
    expect(rowCity(rows[0])).equals('San Diego, CA')
    expect(rowCity(rows[2])).equals(undefined)
  })

  it('knows San Diego’s suburbs by distance, and rows out of ring order', function () {
    expect(MILES_FROM_SAN_DIEGO['San Diego, CA']).equals(0)
    expect(MILES_FROM_SAN_DIEGO['National City, CA']).within(3, 5)
    expect(MILES_FROM_SAN_DIEGO['Escondido, CA']).within(25, 35)
    expect(MILES_FROM_SAN_DIEGO['Sacramento, CA']).greaterThan(400)
    const sanDiego = row('A', 'San Diego, CA')
    const nationalCity = row('B', 'National City, CA')
    const chulaVista = row('C', 'Chula Vista, CA')
    const laMesa = row('D', 'La Mesa, CA')
    expect(
      ringProblems([sanDiego, nationalCity, laMesa, chulaVista, row('E')])
    ).deep.equals([])
    expect(ringProblems([nationalCity, sanDiego])).deep.equals([
      'Open A (San Diego, CA) is after a farther row'
    ])
  })

  it('asks again until a check passes, and gives up with its last failure', async function () {
    let tries = 0
    expect(
      await within(
        1000,
        async () => {
          if (++tries < 3) throw new Error('not yet')
          return tries
        },
        1
      )
    ).equals(3)
    let failure: unknown
    await within(
      20,
      async () => {
        throw new Error('never')
      },
      5
    ).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('never')
    // A wait that cannot succeed ends at once.
    tries = 0
    failure = undefined
    await within(
      1000,
      async () => {
        tries++
        throw new Overtaken('too late')
      },
      1
    ).catch((error: unknown) => {
      failure = error
    })
    expect(failure).instanceOf(Overtaken)
    expect(tries).equals(1)
  })

  it('blocks a stack with no Jev stand-in, and finds the API', function () {
    expect(() => jevOf(context({}))).to.throw(BlockedError)
    const jev = { read: async () => undefined, set: async () => undefined }
    expect(jevOf(context({ jev }))).equals(jev)
    expect(apiBase(context({}))).equals('https://e2e-01.example.test/api/v1')
    expect(
      apiBase(context({ attached: { api: 'https://api.example.test/v1/' } }))
    ).equals('https://api.example.test/v1')
  })

  it('writes a proving log to the run directory', function () {
    const runDir = mkdtempSync(join(tmpdir(), 'search-rig-run-'))
    proveLog(context({}, runDir), 'jev-live.log', 'model: x\n')
    expect(readFileSync(join(runDir, 'jev-live.log'), 'utf8')).equals(
      'model: x\n'
    )
  })

  it('counts the API log’s lines through the stack, and nothing without a way to', async function () {
    expect(await serverLogCount(context({}), 'x')).equals(undefined)
    expect(await serverLogCount(context({ control: {} }), 'x')).equals(
      undefined
    )
    const asked: string[] = []
    expect(
      await serverLogCount(
        context({
          control: {
            logCount: async (needle: string) => {
              asked.push(needle)
              return 2
            }
          }
        }),
        'jev: ranked by jev-1'
      )
    ).equals(2)
    expect(asked).deep.equals(['jev: ranked by jev-1'])
  })

  it('keeps the search socket’s frames by socket and seq', function () {
    const log = searchFrameLog()
    const search = (seq: number, text: string): string =>
      JSON.stringify({ type: 'search', seq, text, location: null, mode: 'all' })
    const results = (seq: number, stage: string): string =>
      JSON.stringify({
        type: 'results',
        seq,
        stage,
        results: [],
        locations: []
      })
    expect(log.frames.lastSent()).equals(undefined)
    log.sent('a', search(1, 'h'))
    log.sent('a', 'not json')
    log.sent('a', JSON.stringify({ type: 'other', seq: 9, text: 'x' }))
    log.received('a', results(1, 'lexicographic'))
    log.received('a', '{"type":"error","code":"malformed"}')
    log.received('a', '{')
    log.sent('a', search(2, 'hawk'), 1234)
    expect(log.frames.lastSent()).deep.equals({
      socket: 'a',
      seq: 2,
      text: 'hawk',
      at: 1234
    })
    expect(log.frames.sockets()).equals(1)
    expect(log.frames.answers({ socket: 'a', seq: 1 })).deep.equals([
      'lexicographic'
    ])
    expect(log.frames.answers(log.frames.lastSent()!)).deep.equals([])
    // A new socket numbers its frames from 1 again.
    const before = Date.now()
    log.sent('b', search(1, 'hawk'))
    expect(log.frames.lastSent()!.at).within(before, Date.now())
    expect(log.frames.sockets()).equals(2)
    expect(log.frames.answers(log.frames.lastSent()!)).deep.equals([])
    log.received('b', results(1, 'lexicographic'))
    log.received('b', results(1, 'jev'))
    expect(log.frames.answers(log.frames.lastSent()!)).deep.equals([
      'lexicographic',
      'jev'
    ])
    expect(log.frames.stages()).deep.equals([
      'lexicographic',
      'lexicographic',
      'jev'
    ])
  })

  it('reads the rows only once they answer the whole typed text and hold still', async function () {
    const log = searchFrameLog()
    const shown: SearchRow[][] = []
    let reads = 0
    const web = {
      page: {
        evaluate: async () => {
          reads++
          return shown.length > 1 ? shown.shift() : shown[0]
        }
      }
    } as any
    const prefix = [row('Demo Hawks 8c00', 'Team')]
    const whole = [row('Demo Hawks 8cd6', 'Team')]
    // The answer to a prefix is on screen: not read.
    log.sent('a', JSON.stringify({ type: 'search', seq: 1, text: '8c' }))
    log.received(
      'a',
      JSON.stringify({ type: 'results', seq: 1, stage: 'lexicographic' })
    )
    shown.push(prefix)
    let failure: unknown
    await answered(web, log.frames, '8cd6', {
      timeoutMs: 30,
      settleMs: 1
    }).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('last asked for "8c"')
    expect(reads).equals(0)
    // Asked, not yet answered.
    log.sent('a', JSON.stringify({ type: 'search', seq: 2, text: '8cd6' }))
    failure = undefined
    await answered(web, log.frames, '8cd6', {
      timeoutMs: 30,
      settleMs: 1
    }).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('no results answer')
    failure = undefined
    await answered(web, log.frames, '8cd6', {
      stage: 'jev',
      timeoutMs: 30,
      settleMs: 1
    }).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('no jev answer')
    // Answered: the prefix's rows still show once, then the whole text's.
    log.received(
      'a',
      JSON.stringify({ type: 'results', seq: 2, stage: 'lexicographic' })
    )
    shown.push(whole)
    const ready: SearchRow[][] = []
    const got = await answered(web, log.frames, '8cd6', {
      settleMs: 1,
      timeoutMs: 1000,
      ready: rows => {
        ready.push(rows)
      }
    })
    expect(got.rows).deep.equals(whole)
    expect(ready).deep.equals([whole])
    expect(got.seenAt).a('number')
    // `ready` can ask for more, and a custom read is used.
    let calls = 0
    const names = await answered(web, log.frames, '8cd6', {
      settleMs: 1,
      timeoutMs: 1000,
      read: async () => ['Corbin B'],
      ready: () => {
        if (++calls < 2) throw new Error('not yet')
      }
    })
    expect(names.rows).deep.equals(['Corbin B'])
    expect(calls).equals(2)
  })

  it('refuses a lexicographic read once Jev has answered the same seq', async function () {
    const log = searchFrameLog()
    const whole = [row('Demo Hawks 8cd6', 'Team')]
    let reads = 0
    const web = {
      page: {
        evaluate: async () => {
          // Jev's frame arrives while the rows are being read.
          if (++reads === 2)
            log.received(
              'a',
              JSON.stringify({ type: 'results', seq: 1, stage: 'jev' })
            )
          return whole
        }
      }
    } as any
    log.sent('a', JSON.stringify({ type: 'search', seq: 1, text: '8cd6' }))
    log.received(
      'a',
      JSON.stringify({ type: 'results', seq: 1, stage: 'lexicographic' })
    )
    let failure: unknown
    await answered(web, log.frames, '8cd6', {
      stage: 'lexicographic',
      settleMs: 1,
      timeoutMs: 1000
    }).catch((error: unknown) => {
      failure = error
    })
    expect(failure).instanceOf(Overtaken)
    expect(String(failure)).includes('before its lexicographic rows')
    expect(reads, 'not asked again').equals(2)
    // Without a stage, or for Jev's, the same rows are fine.
    expect(
      (await answered(web, log.frames, '8cd6', { settleMs: 1 })).rows
    ).deep.equals(whole)
    expect(
      (await answered(web, log.frames, '8cd6', { stage: 'jev', settleMs: 1 }))
        .rows
    ).deep.equals(whole)
    // A new seq, answered only lexicographically so far, reads again.
    log.sent('a', JSON.stringify({ type: 'search', seq: 2, text: '8cd6' }))
    log.received(
      'a',
      JSON.stringify({ type: 'results', seq: 2, stage: 'lexicographic' })
    )
    reads = 10
    expect(
      (
        await answered(web, log.frames, '8cd6', {
          stage: 'lexicographic',
          settleMs: 1
        })
      ).rows
    ).deep.equals(whole)
  })

  it('declares a search spec on a stack, with the search world', function () {
    const spec = searchSpec({
      id: 'app-shell/search/x',
      title: 't',
      covers: ['src/**'],
      minutes: 1,
      scenarios: { a: async () => undefined }
    })
    expect(spec).to.include({ stack: 'isolated', exclusive: true })
    expect(spec.fixtures).deep.equals(['search'])
    expect(spec.secrets).deep.equals([])
    expect(spec.services).deep.equals([])
    expect(spec.surfaces['web-chromium']).deep.equals({
      devices: [],
      browser: { role: 'browser', needs: [] }
    })
    expect(
      searchSpec({
        id: 'people/add-existing/x',
        title: 't',
        covers: ['src/app/scoring/x.tsx'],
        minutes: 1,
        browserNeeds: ['gpu'],
        scenarios: { a: async () => undefined }
      }).surfaces['web-chromium']?.browser?.needs
    ).deep.equals(['gpu'])
  })
})
