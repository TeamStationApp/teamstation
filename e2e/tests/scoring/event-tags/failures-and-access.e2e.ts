import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { tagTargets } from '../../../../src/common/eventTags'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import {
  apiAs,
  centre,
  type Node,
  openPhoneScorer,
  scorePath,
  sleep,
  until
} from '../../../rigs/scoring/phoneScorer'

/**
 * Event tags when the server says no, or is slow, in Safari and in the app
 * on an iPhone (`event-tags`'s `edge` game):
 *
 * - a tag saved on an event the server no longer holds closes the editor
 *   and says so; once the event is back, the tag is saved (the app's held
 *   queue by Try Again, the browser by saving again);
 * - a slow save cannot close an editor opened on another event since;
 * - after switching game and account, an old account's slow save neither
 *   closes the new editor nor reaches the new account's recent tags, which
 *   stay its own;
 * - a member who may only read sees scoring read-only and cannot tag.
 *
 * The event is taken away and put back on the stack's database; a save is
 * held by the stack's fault server delaying the game's tag route. Nothing
 * in the app is a hook.
 */

/** Ids go into the backup table's statements as literals; these are safe. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Unsafe id ${id}`)
  return id
}

/** How long the fault server holds a held tag save. */
const HELD_MS = 20000

async function edges(ctx: HarnessContext): Promise<void> {
  const world = await ctx.fixture('event-tags')
  const game = safeId(world.ids.edge)
  const home = world.ids.edgeHome
  const backup = `e2e_dropped_${safeId(world.nonce)}`
  const control = ctx.stack.control
  if (control == null)
    throw new BlockedError('this stack has no control routes to hold a save')
  const { client } = await apiAs(ctx, world.accounts.scorer)
  const other = await apiAs(ctx, world.accounts.admin)
  const app = await openPhoneScorer(ctx, 'scorer')
  const { m, browser } = app
  const name = browser ? 'safari' : 'native'
  const report: string[] = []
  const log = (line: string): void => {
    report.push(line)
  }
  let dropped = false
  const fixture = {
    /** Takes the struck-out batter's play away, keeping it to put back. */
    drop: async () => {
      await stackSql(
        ctx,
        `create table ${backup} as select * from events where "gameId" = '${game}' and "atBatIndex" = 0`
      )
      await stackSql(
        ctx,
        `delete from events where "gameId" = $1 and "atBatIndex" = 0`,
        [game]
      )
      dropped = true
    },
    restore: async () => {
      if (!dropped) return
      await stackSql(ctx, `insert into events select * from ${backup}`)
      await stackSql(ctx, `drop table ${backup}`)
      dropped = false
    },
    lock: async () => {
      await control.call('PUT', 'delay', {
        prefix: `/api/v1/games/${game}/tags`,
        ms: HELD_MS
      })
    },
    release: async () => {
      await control.call('PUT', 'delay', null)
    }
  }
  const nodes = async (): Promise<Node[]> => await app.nodes()
  const has = async (text: string): Promise<boolean> =>
    (await nodes()).some(node => node.text === text)
  const visible = async (text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 20000 })
  }
  const absent = async (text: string): Promise<void> => {
    await m.assertNotVisible({ text, timeout: 10000 })
  }
  const tap = async (text: string): Promise<void> => {
    const choices = (await nodes()).filter(
      node => node.text === text && node.bounds != null
    )
    const found = choices.find(node => node.type === 'Button') ?? choices[0]
    if (found?.bounds == null) {
      await m.tapOn({ text: `^${text}$`, timeout: 10000 })
      return
    }
    const at = centre(found.bounds)
    await m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
  }
  const field = async (): Promise<void> => {
    await visible('Open scoring menu')
    await visible('^Host 08$')
    const warning = (await nodes()).find(
      node => node.text?.includes('Open debugger to view warnings.') === true
    )
    if (warning?.bounds != null)
      await m.tapOnPoint({
        x: Math.round(warning.bounds.x + warning.bounds.width - 24),
        y: Math.round(warning.bounds.y + warning.bounds.height / 2)
      })
  }
  const openScore = async (id = game): Promise<void> => {
    await app.open(scorePath(id) + (browser ? `?edge=${Date.now()}` : ''))
    await field()
  }
  const hold = async (text?: string): Promise<void> => {
    const found = (await nodes()).find(node =>
      text == null
        ? node.text?.startsWith('Undo ') === true
        : node.text === text
    )
    expect(found?.bounds, 'History control must be visible').to.not.equal(
      undefined
    )
    const at = centre(found!.bounds!)
    await m.tapOnPoint({
      x: Math.round(at.x),
      y: Math.round(at.y),
      duration: 2200
    })
  }
  const editor = async (): Promise<void> => {
    await hold()
    await visible('Tap event to assign a tag.')
    await tap('Tag event: Strikeout')
    await visible('New tag')
  }
  const type = async (value: string): Promise<void> => {
    await tap('New tag')
    await m.eraseText({ characters: 128 })
    await m.inputText({ text: value })
    await m.hideKeyboard()
  }
  /** Whether the server holds `tag` on any event of the game. */
  const serverHas = async (tag: string): Promise<boolean> => {
    const stored = await client.gameEvents(game)
    return [
      ...stored.plays,
      ...(stored.currentPlay == null ? [] : [stored.currentPlay])
    ]
      .flatMap(tagTargets)
      .some(value => value.tag === tag)
  }
  const exit = async (): Promise<void> => {
    if (await has('Cancel')) await tap('Cancel')
    if (await has('Open scoring menu')) {
      await tap('Open scoring menu')
      await tap('Exit Current Game')
      await until(
        async () =>
          (await has('Discard and Exit')) ||
          (await nodes()).some(
            node => node.text?.startsWith('Account,') === true
          ),
        'Scoring exit did not finish'
      )
      if (await has('Discard and Exit')) await tap('Discard and Exit')
    }
  }
  const switchUser = async (role: string): Promise<void> => {
    await exit()
    const account = (await nodes()).find(
      node => node.text?.startsWith('Account,') === true && node.bounds != null
    )
    expect(account?.text, 'Account navigation must be reachable').to.not.equal(
      undefined
    )
    await tap(account!.text!)
    await tap('Account')
    await m.scrollUntilVisible({
      element: { text: '^Sign out$' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await tap('Sign out')
    await visible('Sign in to TeamStation')
    await ctx.signIn(role, m)
  }
  const clearTags = async (): Promise<void> => {
    const stored = await client.gameEvents(game)
    for (const target of [
      ...stored.plays,
      ...(stored.currentPlay == null ? [] : [stored.currentPlay])
    ].flatMap(tagTargets))
      if (target.tag != null) await client.saveEventTag(game, target.id, null)
  }
  try {
    await app.open(scorePath(home, false))
    const accountHistory = (await other.client.tagChoices()).recent
    log(`${name}: begin real failure/retry and stale-completion cases`)
    await clearTags()
    await openScore()
    await editor()
    await fixture.drop()
    await type('great catch')
    if (await has('Save tag')) await tap('Save tag')
    // Saving closes the editor at once; the refusal is said behind it: in
    // the browser by the scoring toast (the editor's onFailed), on the
    // phone by the held-game notice ("Not sent: …") over the queued tag.
    await absent('New tag')
    await visible('.*This scoring event no longer exists.*')
    await fixture.restore()
    if (!browser) {
      // The refused tag is held on the game's queue, as entered: Try Again
      // sends it again, under the same key.
      await tap('Try Again')
    } else {
      await editor()
      await type('great catch')
      if (await has('Save tag')) await tap('Save tag')
      await absent('New tag')
    }
    await until(
      async () => await serverHas('great catch'),
      'The restored target did not take the tag'
    )
    log(
      `${name}: real target404 closes the editor and says so; restored target retries successfully PASS`
    )
    await editor()
    const stored = await client.gameEvents(game)
    const target = stored.plays
      .flatMap(tagTargets)
      .find((value: any) => value.completed === true)
    expect(target, 'The completed event must exist').to.not.equal(undefined)
    await fixture.lock()
    await type('quick release')
    if (await has('Save tag')) await tap('Save tag')
    // The editor closes at once, the save still held by the server.
    await absent('New tag')
    await hold()
    await tap('Tag event: Called Strike')
    await visible('New tag')
    await fixture.release()
    await until(
      async () =>
        (await client.gameEvents(game)).plays
          .flatMap(tagTargets)
          .find((value: any) => value.id === target.id)?.tag ===
        'quick release',
      'Old save did not complete',
      HELD_MS + 15000
    )
    await sleep(1000)
    await visible('Called Strike')
    await visible('New tag')
    await tap('Cancel')
    log(
      `${name}: old queued save cannot close a newly selected event editor PASS`
    )
    await editor()
    await fixture.lock()
    await type('sharp defense')
    if (await has('Save tag')) await tap('Save tag')
    await absent('New tag')
    await switchUser('admin')
    await openScore(home)
    await editor()
    if (accountHistory.length === 0) await absent('Recent tags')
    else await visible('Recent tags')
    await fixture.release()
    await until(
      async () =>
        (await client.gameEvents(game)).plays
          .flatMap(tagTargets)
          .find((value: any) => value.id === target.id)?.tag ===
        'sharp defense',
      'Old-account save did not complete',
      HELD_MS + 15000
    )
    await sleep(1000)
    await visible('New tag')
    expect(
      (await other.client.tagChoices()).recent,
      'Old-account completion must not alter the new account history'
    ).to.deep.equal(accountHistory)
    if (accountHistory.length === 0) await absent('Recent tags')
    await tap('Cancel')
    await openScore()
    await editor()
    await tap('Use tag great catch')
    await absent('New tag')
    await editor()
    await visible('Recent tags')
    await tap('Cancel')
    log(
      `${name}: game/account switch invalidates old selection; fresh account history remains isolated and reuse is recorded PASS`
    )
    await switchUser('member')
    await openScore()
    await tap('Ball')
    await visible('Scoring is read-only')
    await visible('Nothing to undo')
    await hold('Nothing to undo')
    await absent('Tap event to assign a tag.')
    await absent('New tag')
    log(
      `${name}: actual member403 makes scoring read-only and blocks tag editing PASS`
    )
  } finally {
    await fixture.release().catch(() => undefined)
    await fixture.restore().catch(() => undefined)
    await clearTags().catch(() => undefined)
    writeFileSync(ctx.artifact('tags-edge.log'), report.join('\n') + '\n')
  }
}

const iphone = {
  // The scoring field draws in 3D: a GPU, so a physical iPhone.
  devices: [
    { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' as const }
  ]
}

export default defineHarness({
  id: 'scoring/event-tags/failures-and-access',
  title: 'Event tags survive refused and slow saves, and readers cannot tag',
  kind: 'e2e',
  covers: [
    'src/app/scoring/EventTagEditor.tsx',
    'src/app/scoring/localEventTags.ts',
    'src/server/events/eventTags.ts'
  ],
  stack: 'isolated',
  fixtures: ['event-tags'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': iphone,
    'ios-app': iphone
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'failures-and-access': edges
  }
})
