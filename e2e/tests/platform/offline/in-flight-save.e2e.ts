import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { expect } from 'chai'

import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext } from '../../../core/spec'
import {
  type CoachApp,
  DEVELOP_APP,
  labelOf,
  openCoachApp
} from '../../../rigs/coach/coachApp'

/**
 * A pitch whose save is still on its way when the scorer leaves, and
 * scoring opened again once the screen has gone (#358, the in-flight save).
 *
 * The stack's fault server holds the Ball's request (`api-hang`): the
 * server has not answered when the scorer leaves and comes back, inside the
 * phone's request deadline (10 s). Scoring opens at once on the phone's own
 * copy, which is to hold that Ball, and a Strike scored on it goes behind
 * it. (On the stack base it sat loading until the deadlines passed, then
 * opened with the Ball: `in-flight-save-before.log`.) Once the fault is cleared the held request
 * is dropped, and the queue sends what it holds: the server ends with every
 * pitch, in order, and nothing is refused.
 *
 * Each step's board and screenshot are recorded (`observations.json`)
 * before anything is asserted, so a run on a build without the fix records
 * what that build does.
 */

interface World {
  game: string
  coach: { email: string; password: string }
}

async function worldOf(ctx: E2eContext): Promise<World> {
  const world = await ctx.fixture('coach-game')
  const coach = world.accounts.coach
  return {
    game: world.ids.game,
    coach: { email: coach.email, password: coach.password }
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Reads `path` from the stack's API as the home team's coach. */
async function asCoach(
  ctx: E2eContext,
  world: World,
  path: string
): Promise<unknown> {
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const token = await signInTestAccount(
    `${ctx.stack.origin}/api/v1`,
    world.coach
  )
  return await readJson(ctx.stack.origin, `/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` }
  })
}

/** The pitch calls the server holds for the game, in order. */
async function callsOnServer(ctx: E2eContext, world: World): Promise<string[]> {
  const events = JSON.stringify(
    await asCoach(ctx, world, `/games/${world.game}/events`)
  )
  return [...events.matchAll(/"call":\{"code":"([A-Z*]+)"/g)].map(
    found => found[1]
  )
}

/** The board's count as the screen reads it out, or what it shows instead. */
async function board(app: CoachApp): Promise<string> {
  const labels = (await app.nodes()).map(labelOf)
  const count = labels.find(label => / balls? /.test(label))
  if (count != null) return count
  return labels.find(label => /Unable to load|Retry/.test(label)) ?? 'no board'
}

/** Whether a node with this id is on screen. */
async function shownId(app: CoachApp, id: string): Promise<boolean> {
  return (await app.nodes()).some(node => node.id === id)
}

async function openScoring(app: CoachApp, world: World): Promise<void> {
  await app.m.openLink({ link: `teamstation://games/${world.game}/score` })
  await app.m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 60000 })
}

export default defineE2e({
  id: 'platform/offline/in-flight-save',
  title:
    'A pitch still being saved when the scorer leaves is on the board when scoring opens again, and reaches the server in order',
  kind: 'e2e',
  covers: [
    'src/app/sync/outbox.ts',
    'src/app/sync/cachingClient.ts',
    'src/app/scoring/ScoringScreen.tsx',
    'src/common/scoring/session.ts'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios'], hardware: 'none' }]
    }
  },
  services: ['web', 'api'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  // The scenario sets and clears `api-hang` itself, as setup.
  faults: [],
  manual: false,
  scenarios: {
    'reopen-gone': async ctx => {
      const setFault = ctx.stack.setFault
      if (setFault == null)
        throw new BlockedError('needs a stack whose fault server can be set')
      const world = await worldOf(ctx)
      const app = await openCoachApp(ctx, 'scorekeeper')
      const { m } = app
      const seen: Array<Record<string, unknown>> = []
      const note = async (step: string): Promise<void> => {
        await m.takeScreenshot({ path: ctx.artifact(`${step}.png`) })
        seen.push({
          step,
          at: new Date().toISOString(),
          board: await board(app),
          heldGameNotice: await shownId(app, 'heldGameNotice'),
          saveStatus: (await app.nodes())
            .filter(node => node.id === 'scoringSaveStatus')
            .map(labelOf)
        })
        writeFileSync(
          ctx.artifact('observations.json'),
          JSON.stringify(seen, null, 2)
        )
      }
      await openScoring(app, world)
      await m.tapOn({ text: 'Ball' })
      await sleep(3000)
      const online = await callsOnServer(ctx, world)
      expect(online, 'the first Ball reached the server').deep.equals(['B'])
      let cleared = false
      await setFault('api-hang')
      try {
        // The second Ball's request is held: no answer has come. Leaving and
        // opening scoring again happen inside the request deadline (10 s),
        // while the send is still in flight: past it the phone takes the
        // send as no signal and queues it.
        // One request, run on the device's host: driven step by step through
        // the hub it takes longer than the deadline.
        const tapped = Date.now()
        await m.run(
          [
            { tapOn: { text: 'Ball' } },
            { openLink: `teamstation://games/${world.game}` },
            {
              extendedWaitUntil: { notVisible: { text: 'Ball' }, timeout: 8000 }
            },
            { openLink: `teamstation://games/${world.game}/score` },
            { takeScreenshot: 'reopened-opening' }
          ],
          { cwd: dirname(ctx.artifact('reopened-opening.png')) }
        )
        seen.push({ step: 'reopening-after-ms', ms: Date.now() - tapped })
        // Opened in the window: what the screen shows until the board is up.
        await m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 30000 })
        seen.push({ step: 'reopened-after-ms', ms: Date.now() - tapped })
        await note('reopened')
        // Past the request deadline, still held.
        await sleep(15000)
        await note('after-deadline')
        // A pitch scored on what the screen opened on.
        await m.tapOn({ text: 'Strike' })
        await sleep(2000)
        await note('strike-while-held')
        await setFault(null)
        cleared = true
      } finally {
        if (!cleared) await setFault(null)
      }
      // The held request is dropped; behind and back in front, the queue
      // sends what it holds.
      await m.pressKey({ key: 'home' })
      await sleep(2000)
      await m.launchApp({ appId: DEVELOP_APP, stopApp: false })
      const end = Date.now() + 120000
      let calls = await callsOnServer(ctx, world)
      while (Date.now() < end && calls.length < 3) {
        await sleep(5000)
        calls = await callsOnServer(ctx, world)
      }
      await sleep(5000)
      await note('after-send')
      seen.push({ step: 'server', calls: await callsOnServer(ctx, world) })
      writeFileSync(
        ctx.artifact('observations.json'),
        JSON.stringify(seen, null, 2)
      )
      const at = (step: string): Record<string, unknown> | undefined =>
        seen.find(entry => entry.step === step)
      // The native board draws its count on the field, with no label to
      // read: its screenshots (`reopened.png`, `strike-while-held.png`) show
      // it. What is read: scoring opened at once on the phone's copy, inside
      // the deadline, rather than waiting on the server.
      const opening = seen.find(entry => entry.step === 'reopening-after-ms')
      const opened = seen.find(entry => entry.step === 'reopened-after-ms')
      expect(
        Number(opened?.ms) - Number(opening?.ms),
        'scoring opened without waiting on the server (ms)'
      ).lessThan(5000)
      expect(
        await callsOnServer(ctx, world),
        'every pitch, in order, on the server'
      ).deep.equals(['B', 'B', 'C'])
      expect(at('after-send')?.heldGameNotice, 'nothing refused').equals(false)
    }
  }
})
