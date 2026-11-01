import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import { startingBox } from '../../src/app/tv/replayStatistics'
import { TeamStationClient } from '../../src/common/api'
import { asPostEventsBody } from '../../src/common/gumboPlay'
import type { ReplayBoxScore } from '../../src/common/replay/replayBoxScore'
import {
  replayScore,
  replaySourceOf
} from '../../src/common/replay/replaySource'
import type { ScoringAction } from '../../src/common/scoring/actions'
import { ScoringSession } from '../../src/common/scoring/session'
import { postGamePlays } from '../../src/server/events/postPlays'
import {
  MemoryStore,
  replayActions,
  replaySetup
} from '../../src/test/replayGameFixture'
import { tvFixture } from './fixture'

interface Node {
  id?: string
  text?: string
  children?: Node[]
}
function find(node: Node, id: string): Node | undefined {
  return node.id === id
    ? node
    : node.children?.map(child => find(child, id)).find(Boolean)
}
function words(node: Node): string[] {
  const children = node.children?.flatMap(words) ?? []
  return children.length > 0
    ? children
    : node.text === undefined
      ? []
      : [node.text.trim()]
}
function containsRow(tree: Node, row: Array<string | number>): boolean {
  const text = words(tree).join('|').replace(/\s+/g, ' ')
  return text.includes(row.map(String).join('|'))
}
async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    MAESTRO_D_CLIENT_ROOT: root,
    TV_METRO_URL: metro
  } = process.env
  assert(
    device !== undefined &&
      root !== undefined &&
      metro !== undefined &&
      process.env.MAESTRO_D !== undefined &&
      process.env.MAESTRO_D_WEB !== undefined
  )
  assert.equal(process.env.TV_CAPTURE_MODE, 'none')
  const { MaestroD } = createRequire(path.join(root, 'package.json'))(
    './dist/cjs/index.js'
  )
  const h = await tvFixture({ scored: true, webRoot: path.resolve('dist') })
  const daemon = await MaestroD.connect({ name: process.env.MAESTRO_D })
  const webDaemon = await MaestroD.connect({ name: process.env.MAESTRO_D_WEB })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  let browser: any
  const client = new TeamStationClient({
    baseUrl: `${h.origin}/api/v1`,
    token: h.tokens.get(101)
  })
  const setup = replaySetup()
  for (const person of Object.values(setup.players))
    person.teamId =
      person.teamId === 'tem_replayHawks' ? 'tem_opponent' : 'tem_account'
  const actions = replayActions(setup)
  const publish = async (
    selected: ScoringAction[]
  ): Promise<ReplayBoxScore> => {
    const store = new MemoryStore()
    let time = Date.UTC(2026, 9, 30, 18)
    const session = await ScoringSession.open(
      store,
      'gam_tv_0',
      {
        gamePk: 'gam_tv_0',
        setup,
        teams: {
          away: { id: 'tem_opponent', name: 'Demo Visitors' },
          home: { id: 'tem_account', name: 'Demo Hawks' }
        }
      },
      {
        now: () => new Date((time += 200)),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    for (const action of selected)
      assert.equal(session.apply(action).problems.length, 0)
    await session.flush()
    const stored = store.storedForms()
    const previous = await client.gameEvents('gam_tv_0')
    await postGamePlays(
      h.db,
      'gam_tv_0',
      asPostEventsBody({
        ...stored,
        mode: 'live',
        source: { system: 'teamstation' },
        remove: previous.plays
          .map(play => play.about.atBatIndex)
          .filter(
            index => !stored.plays.some(play => play.about.atBatIndex === index)
          )
      })
    )
    const game = await client.game('gam_tv_0')
    const source = replaySourceOf(game, await client.gameEvents(game.id))
    return source === null
      ? startingBox(game, await client.gameLineups(game.id))!
      : replayScore(source.timeline.end, source.timeline)
  }
  const compare = async (
    expected: ReplayBoxScore,
    label: string,
    compareWeb = true
  ): Promise<void> => {
    const deadline = Date.now() + 40000
    for (;;) {
      await browser.evalBrowserScript({
        script: `return JSON.stringify(document.querySelector('[data-testid="replay-box-score"]')?.innerText.split('\\n').filter(Boolean) ?? [])`,
        output: 'rows'
      })
      const webTree: Node = {
        children: (JSON.parse((await browser.vars()).rows) as string[]).map(
          text => ({ text })
        )
      }
      const tvTree = find(await tv.hierarchy(), 'tv-box-panel')
      const rows = (['away', 'home'] as const).flatMap(side => [
        ...expected[side].batting.map(p => ({
          side,
          cells: [p.name, p.ab, p.r, p.h, p.rbi, p.bb, p.k]
        })),
        ...expected[side].pitching.map(p => ({
          side,
          cells: [p.name, p.ip, p.h, p.r, p.er, p.bb, p.k, p.pc]
        }))
      ])
      if (
        webTree !== undefined &&
        tvTree !== undefined &&
        rows.every(
          row =>
            (!compareWeb || containsRow(webTree, row.cells)) &&
            containsRow(tvTree, row.cells)
        )
      ) {
        console.log(
          `PASS ${label}: ${compareWeb ? 'browser and TV' : 'TV pregame'} rendered batting/pitching tables match the shared state`
        )
        return
      }
      if (Date.now() > deadline) {
        console.log(
          'Missing rows',
          rows.filter(
            row =>
              !containsRow(webTree, row.cells) ||
              tvTree === undefined ||
              !containsRow(tvTree, row.cells)
          )
        )
        console.log('Browser rows', JSON.stringify(words(webTree)))
        console.log(
          'TV rows',
          JSON.stringify(tvTree === undefined ? [] : words(tvTree))
        )
        throw new Error(`Rendered parity failed: ${label}`)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  try {
    const first = await publish(actions.slice(0, 1))
    browser = await webDaemon.attach({
      device: `${process.env.MAESTRO_D_WEB}-replay`,
      platform: 'web',
      appId: h.origin,
      extra: { browser: 'chromium', windowSize: '1280x900' },
      artifacts: 'none'
    })
    await browser.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: h.tokens.get(101),
          domain: new URL(h.origin).hostname,
          path: '/',
          httpOnly: true,
          secure: false
        }
      ]
    })
    await browser.openBrowser({ url: `${h.origin}/games/gam_tv_0/replay` })
    await browser.assertVisible({ id: 'game-replay', timeout: 60000 })
    await tv.launchApp({
      appId: 'app.teamstation.tv',
      stopApp: true,
      environment: {
        TV_API_BASE_URL: `${h.origin}/api/v1`,
        TV_METRO_URL: metro
      }
    })
    await tv.assertVisible({
      text: 'Your games. On the big screen.',
      timeout: 60000
    })
    await tv.tapOn({ text: 'Dismiss', optional: true, timeout: 1000 })
    const code = words(await tv.hierarchy())
      .map(text => /[A-Z]{4}[–-][A-Z]{4}/.exec(text)?.[0])
      .find(Boolean)
    assert(code !== undefined)
    assert.equal(
      (await h.request('POST', '/auth/tv/approve', { code })).status,
      204
    )
    await tv.assertVisible({ text: 'Recent Games', timeout: 30000 })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
    await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
    await tv.pressKey({ key: 'playPause' })
    for (let i = 0; i < 5; i++) await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_UP' })
    for (let i = 0; i < 3; i++) await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await compare(first, 'first pitch')
    await compare(await publish(actions.slice(0, 6)), 'completed walk')
    const substitution = actions.findIndex(
      action => action.type === 'lineup' && action.kind === 'substitute'
    )
    assert(substitution >= 0)
    await compare(
      await publish(actions.slice(0, substitution + 1)),
      'substitution'
    )
    await compare(
      await publish(actions.slice(0, 1)),
      'live correction back to first pitch'
    )
    await browser.tapOn({ id: 'replay-pause' })
    await browser.tapOn({ id: 'replay-rewind' })
    await tv.pressKey({ key: 'BACK' })
    await new Promise(resolve => setTimeout(resolve, 600))
    for (let i = 0; i < 6; i++) {
      await tv.pressKey({ key: 'DPAD_LEFT' })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await tv.assertVisible({ id: 'tv-current-time', text: '0:00' })
    await tv.pressKey({ key: 'DPAD_UP' })
    for (let i = 0; i < 3; i++) await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    const source = replaySourceOf(
      await client.game('gam_tv_0'),
      await client.gameEvents('gam_tv_0')
    )!
    await compare(
      replayScore(source.timeline.start, source.timeline),
      'rewind to known starters'
    )
    const pregame = await publish([{ type: 'lineup', kind: 'roster', setup }])
    const unstarted = await client.gameEvents('gam_tv_0')
    assert.equal(unstarted.plays.length, 0)
    assert.equal(
      unstarted.currentPlay?.playEvents.some(event => event.isPitch === true) ??
        false,
      false
    )
    const saved = await h.db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', 'gam_tv_0')
      .executeTakeFirstOrThrow()
    assert.equal(saved.currentPlay, null)
    await compare(pregame, 'known starters without any pitch', false)
  } finally {
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await browser?.detach()
    await webDaemon.shutdown()
    await h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
