import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { WebSocket } from 'ws'

import { TeamStationClient } from '../common/api'
import { signInTestAccount } from './passwordFixtures'

/** Simulator-only scoring regression journey against an explicitly selected
 * development seat. The fixture contains synthetic teams, players and a login;
 * credentials and device identifiers are supplied at runtime, never committed.
 * Run: node -r sucrase/register src/test/scoringTweaks.e2e.ts
 */
const required = (key: string): string => {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`Set ${key}`)
  return value
}
const app = required('TS_SCORING_TEST_URL').replace(/\/$/, '')
if (
  ['web.teamstation.app', 'app.teamstation.app'].includes(new URL(app).hostname)
)
  throw new Error('Use a development seat, never production')
const device = required('TS_SCORING_SIMULATOR_UDID')
const artifacts = required('TS_E2E_ARTIFACT_DIR')
const bin = required('MAESTRO_D_BIN')
const requireClient = createRequire(
  join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
)
const { MaestroD } = requireClient('maestro-d')
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const booted = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  )
  if (
    !(Object.values(booted.devices).flat() as any[]).some(
      d => d.udid === device
    )
  )
    throw new Error('The selected device must already be a running simulator')
  execFileSync(bin, ['ps'], { stdio: 'inherit' })
  const fixture = JSON.parse(
    await readFile(required('TS_E2E_FIXTURE_FILE'), 'utf8')
  )
  const game = fixture.games[Number(process.env.TS_E2E_GAME_INDEX ?? 1)]
  const api = new TeamStationClient({
    baseUrl: `${app}/api/v1`,
    token: await signInTestAccount(`${app}/api/v1`, fixture)
  })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'scoring-tweaks-e2e',
    bin,
    idleTimeout: 0
  })
  const sim = await daemon.attach({
    device,
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure'
  })
  await mkdir(artifacts, { recursive: true })
  const log: string[] = [
    '$ node -r sucrase/register src/test/scoringTweaks.e2e.ts'
  ]
  const note = (text: string): void => {
    log.push(text)
    console.log(text)
  }
  const snapshot = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name), await sim.screenshot())
  }
  const nodes = (n: any): any[] => [n, ...(n.children ?? []).flatMap(nodes)]
  const read = async (): Promise<any> => await api.gameEvents(game)
  const current = async (): Promise<any> => (await read()).currentPlay
  const wait = async (
    label: string,
    check: () => Promise<boolean>
  ): Promise<void> => {
    const until = Date.now() + 15000
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out: ${label}`)
      await pause(100)
    }
  }
  const tap = async (text: string): Promise<void> => {
    await sim.tapOn({ text })
  }
  const undo = async (actions: number): Promise<void> => {
    await tap('^Undo.*')
    await wait(
      'Undo persisted',
      async () =>
        ((await current())?.teamStation?.actions ?? []).length === actions
    )
    await pause(400)
  }
  const drag = async (point = '39%,44.5%'): Promise<void> => {
    await sim.command('dragAndDrop', {
      from: { text: '^Visitor 01$', index: 0 },
      to: { point },
      holdDuration: 500,
      duration: 1800
    })
  }
  const choose = async (reason: string): Promise<void> => {
    await drag()
    await tap(`^${reason}$`)
  }
  const sendPitch = async (label: string): Promise<void> => {
    const count = ((await current())?.teamStation?.actions ?? []).length
    await tap(`^${label}$`)
    await wait(
      'pitch persisted',
      async () =>
        ((await current())?.teamStation?.actions ?? []).length !== count
    )
    await pause(450)
  }
  let publisher: WebSocket | undefined
  let restoreSettings:
    Awaited<ReturnType<TeamStationClient['nodeSettings']>> | undefined
  try {
    if (process.env.TS_E2E_RESET_FIXTURE === '1') {
      const detail = await api.game(game)
      expect(detail.awayTeamName).equals('Silver Rockets')
      expect(detail.homeTeamName).equals('Copper Comets')
      const stored = await read()
      await api.saveGameEvents(game, {
        plays: [],
        remove: stored.plays.map((p: any) => p.about.atBatIndex),
        currentPlay: null
      })
    }
    await sim.openLink({ link: `${app}/games/${game}/score` })
    await sim.assertVisible({ text: '^Ball$', timeout: 15000 })
    // A fresh fixture: four balls put the first visitor on first base.
    if (
      (await read()).plays.length === 0 &&
      ((await current())?.teamStation?.actions ?? []).length === 0
    ) {
      for (let i = 0; i < 4; i++) await sendPitch('Ball')
    }
    await sim.assertVisible({ text: '^Visitor 01$', timeout: 15000 })
    const baseline = await current()
    const actions = baseline.teamStation.actions.length
    await drag('88%,49%')
    await wait(
      'failed pickoff',
      async () =>
        (await current()).teamStation.actions.at(-1)?.reason ===
        'Safe from Pickoff'
    )
    const pickoff = await current()
    expect(pickoff.count).deep.equals(baseline.count)
    expect(pickoff.runners.at(-1).movement).includes({
      start: '1B',
      end: '1B',
      isOut: false
    })
    expect(pickoff.runners.at(-1).credits).deep.equals([])
    note(
      `S1 failed pickoff: ${JSON.stringify(pickoff.teamStation.actions.at(-1))}`
    )
    await undo(actions)
    for (const [base, target] of [
      [2, '39%,44.5%'],
      [3, '12%,49%']
    ] as const) {
      await drag(target)
      await tap('^Steal$')
      await wait(
        'stolen base',
        async () =>
          (await current()).runners.at(-1)?.movement.end === `${base}B`
      )
      const advanced = await current()
      await drag(target)
      await wait(
        'failed pickoff at advanced base',
        async () =>
          (await current()).teamStation.actions.at(-1)?.reason ===
          'Safe from Pickoff'
      )
      const attempt = await current()
      expect(attempt.count).deep.equals(advanced.count)
      expect(attempt.runners.at(-1).movement).includes({
        start: `${base}B`,
        end: `${base}B`,
        isOut: false
      })
      expect(attempt.runners.at(-1).credits).deep.equals([])
      note(`S1 failed pickoff at base ${base}: count stable, no out or credit`)
      await undo(advanced.teamStation.actions.length)
    }
    await undo(actions + 1)
    await undo(actions)
    for (const reason of ['Throwing Error', 'Fielding Error']) {
      await choose(reason)
      await sim.assertVisible({
        text: `Tap the defender who made the ${reason.toLowerCase()}.`
      })
      await snapshot('runner-choice-after.png')
      await sim.tapOn({ text: '^Host 05$', index: 0 })
      await wait(
        'defender credit',
        async () => (await current()).runners?.at(-1)?.credits?.length === 1
      )
      const credit = (await current()).runners.at(-1).credits[0]
      expect(credit.credit).equals(
        reason === 'Throwing Error' ? 'f_throwing_error' : 'f_fielding_error'
      )
      note(`S2 ${reason}: ${JSON.stringify(credit)}`)
      for (const reuse of [true, false]) {
        await pause(500)
        await drag('12%,49%')
        await tap(`^${reason}$`)
        await sim.tapOn({ text: '^Host 05$', index: 0 })
        await sim.assertVisible({ text: 'Was this the same error?' })
        await snapshot('runner-error-reuse.png')
        await tap(reuse ? '^Use previous error$' : '^Record another error$')
        await wait(
          'error advance persisted',
          async () =>
            (await current()).teamStation.actions.length === actions + 2
        )
        const movements = (await current()).runners
        expect(
          movements
            .flatMap((r: any) => r.credits)
            .filter((c: any) => c.credit === credit.credit)
        ).has.length(reuse ? 1 : 2)
        expect(
          movements.at(-1).details.playIndex ===
            movements.at(-2).details.playIndex
        ).equals(reuse)
        note(
          `S2 ${reason}: ${reuse ? 'shared' : 'separate'} misplay credits verified`
        )
        await undo(actions + 1)
      }
      await undo(actions)
    }
    await choose('Passed Ball')
    await sim.assertVisible({
      text: 'Tap Ball, Called Strike, or Swing and Miss for the passed ball.'
    })
    await snapshot('passed-ball-after.png')
    await tap('^Called Strike$')
    await wait(
      'passed-ball strike',
      async () => (await current()).count.strikes === 1
    )
    expect((await current()).count.balls).equals(baseline.count.balls)
    note(
      'S3 first-pitch passed ball: called strike, one advancement, Undo restores both'
    )
    await undo(actions)
    await sendPitch('Ball')
    const prior = await current()
    const priorActions = prior.teamStation.actions.length
    for (const answer of ['YES', 'NO']) {
      await choose('Passed Ball')
      await snapshot('passed-ball-previous-after.png')
      await tap(`^${answer}$`)
      if (answer === 'NO') await tap('^Swing and Miss$')
      await wait(
        'passed ball saved',
        async () => (await current()).runners?.at(-1)?.movement?.end === '2B'
      )
      expect((await current()).count.strikes).equals(answer === 'NO' ? 1 : 0)
      note(
        `S3 previous-pitch passed ball ${answer}: ${JSON.stringify((await current()).count)}`
      )
      await undo(priorActions)
    }
    for (const choice of [
      'Use previous pitch as wild pitch',
      'Add a pitched ball to the count'
    ]) {
      await choose('Wild Pitch')
      await snapshot('wild-pitch-after.png')
      await tap(`^${choice}$`)
      await wait(
        'wild pitch saved',
        async () => (await current()).runners?.at(-1)?.movement?.end === '2B'
      )
      expect((await current()).count.balls).equals(
        prior.count.balls + (choice.startsWith('Add') ? 1 : 0)
      )
      note(`S3 ${choice}: ${JSON.stringify((await current()).count)}`)
      await undo(priorActions)
    }
    publisher = new WebSocket(
      `${app.replace(/^http/, 'ws')}/api/v1/scoreboard/${game}/publish`,
      { headers: { authorization: `Bearer ${api.token}` } }
    )
    await new Promise<void>((resolve, reject) => {
      publisher!.once('open', resolve)
      publisher!.once('error', reject)
    })
    const packet = async (value: object): Promise<void> => {
      publisher!.send(JSON.stringify(value))
      note(`WebSocket packet ${JSON.stringify(value)}`)
      await pause(200)
    }
    // Clear the plain pitch so two balls can be tested without ending the at-bat.
    await undo(actions)
    await sendPitch('Ball')
    await packet({ pitchSpeed: 88 })
    await wait(
      'late radar',
      async () =>
        (await current()).playEvents.filter((p: any) => p.isPitch).at(-1)
          ?.pitchData?.startSpeed === 88
    )
    await pause(3200)
    await packet({ pitchSpeed: 88 })
    await sendPitch('Called Strike')
    await wait(
      'repeated radar',
      async () =>
        (await current()).playEvents.filter((p: any) => p.isPitch).at(-1)
          ?.pitchData?.startSpeed === 88
    )
    await pause(3200)
    await packet({ pitchSpeed: 86, exitVelocity: 99 })
    await sendPitch('Foul Ball')
    await wait(
      'foul radar',
      async () =>
        (await current()).playEvents.filter((p: any) => p.isPitch).at(-1)
          ?.pitchData?.startSpeed === 86
    )
    const foul = (await current()).playEvents
      .filter((p: any) => p.isPitch)
      .at(-1)
    expect(foul.hitData?.launchSpeed).equals(undefined)
    note(
      `S5 late/repeated/direct foul: ${JSON.stringify((await current()).playEvents.filter((p: any) => p.isPitch))}`
    )
    const beforeUndo = (await current()).teamStation.actions.length
    await undo(beforeUndo - 1)
    await pause(3200)
    expect((await current()).teamStation.actions.length).equals(beforeUndo - 1)
    note('S6 Undo remains removed after the future window closes')
    const hit = async (caughtFoul = false, out = false): Promise<any> => {
      const beforeHit = await current()
      const index = beforeHit.about.atBatIndex
      const endsHalf = out && beforeHit.count.outs === 2
      await tap('^Swing in Play$')
      if (out) {
        await tap('^Batter Out$')
        await tap('^Ball Caught$')
      } else await tap('^Single$')
      if (caughtFoul)
        await sim.command('dragAndDrop', {
          from: { text: '^Host 06$', index: 0 },
          to: { point: '10%,60%' },
          holdDuration: 500,
          duration: 1200
        })
      else await sim.tapOn({ text: '^Host 08$', index: 0 })
      await sim.command('dragAndDrop', {
        from: { point: '50%,55%' },
        to: { point: out ? '50%,50%' : '50%,65%' },
        holdDuration: 300,
        duration: 1000
      })
      // The third out completes automatically; other plays expose Finish.
      if (!endsHalf) {
        await sim.assertVisible({ text: '^Finish at-bat$', timeout: 15000 })
        await sim.tapOn({ text: '^Finish at-bat$', index: 0 })
      }
      await wait('completed batted ball', async () =>
        (await read()).plays.some((p: any) => p.about.atBatIndex === index)
      )
      await pause(700)
      return (await read()).plays.find((p: any) => p.about.atBatIndex === index)
    }
    await packet({ pitchSpeed: 84, exitVelocity: 95 })
    const single = await hit()
    const inPlay = single.playEvents.filter((p: any) => p.isPitch).at(-1)
    expect(inPlay.pitchData.startSpeed).equals(84)
    expect(inPlay.hitData.launchSpeed).equals(95)
    note(
      `S5 simulator hit with fielder/trajectory refinements: ${JSON.stringify(inPlay)}`
    )
    for (let out = 0; out < 3; out++) {
      await packet({ pitchSpeed: 80 + out, exitVelocity: 90 + out })
      const play = await hit(out === 0, true)
      const pitch = play.playEvents.filter((p: any) => p.isPitch).at(-1)
      expect(pitch.pitchData.startSpeed).equals(80 + out)
      expect(pitch.hitData?.launchSpeed).equals(
        out === 0 ? undefined : 90 + out
      )
      if (out === 0) {
        expect(play.teamStation.detail.foulCaught).equals(true)
        expect(play.result.description).equals('Foul ball caught')
      }
      note(
        `S5 ${out === 0 ? 'caught foul' : 'fair catch'}: ${JSON.stringify(pitch)}`
      )
    }
    expect((await current()).about).includes({
      inning: 1,
      halfInning: 'bottom'
    })
    note('S5 completed the scored half-inning with radar values persisted')
    const settings = await api.nodeSettings()
    restoreSettings = settings
    await sim.openLink({ link: `${app}/node` })
    await sim.command('scrollUntilVisible', {
      element: { text: '^Radar pitch window:.*' },
      direction: 'DOWN',
      timeout: 15000
    })
    await snapshot('node-radar-after.png')
    await tap('^Radar pitch window:.*')
    await sim.assertVisible({
      text: `^Pitch window \\(before and after\\): ${settings.radar.pitchWindowSec} s$`
    })
    // iOS exposes this wheel as one adjustable element, not its child rows.
    for (let attempt = 0; attempt < 6; attempt++) {
      const slider = nodes(await sim.hierarchy()).find(n =>
        String(n.text ?? '').startsWith('Pitch window (before and after):')
      )
      if (slider?.text === 'Pitch window (before and after): 4 s') break
      if (slider?.bounds == null) throw new Error('Missing radar wheel')
      const { x, y, width, height } = slider.bounds
      await sim.tapOn({
        point: `${Math.round(x + width / 2)},${Math.round(y + (height * 5) / 6)}`
      })
      await pause(250)
    }
    await sim.assertVisible({
      text: '^Pitch window \\(before and after\\): 4 s$'
    })
    await tap('^Use$')
    await sim.command('scrollUntilVisible', {
      element: { text: '^Save$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('^Save$')
    await wait(
      'radar setting saved',
      async () => (await api.nodeSettings()).radar.pitchWindowSec === 4
    )
    note(
      `S7 node administrator saved radar settings through the simulator UI: ${JSON.stringify((await api.nodeSettings()).radar)}`
    )
    await api.setNodeSettings(settings)
    note('PASS scoring tweaks simulator journey')
  } finally {
    publisher?.close()
    if (restoreSettings != null) await api.setNodeSettings(restoreSettings)
    await writeFile(
      join(artifacts, 'scoring-results.log'),
      log.join('\n') + '\n'
    )
    await writeFile(
      join(artifacts, 'radar-websocket.log'),
      log
        .filter(l => l.startsWith('$') || /WebSocket|S[567]/.test(l))
        .join('\n') + '\n'
    )
    await sim.detach()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
