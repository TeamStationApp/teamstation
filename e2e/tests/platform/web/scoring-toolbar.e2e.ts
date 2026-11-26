import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import { signInTestAccount } from '../../../../src/test/passwordFixtures'
import { faultControl, requireDropletHandle } from '../../../core/dropletStack'
import { readJson } from '../../../core/readback'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import { browserAppOf } from '../../../rigs/mobileWeb'
import {
  expectSwapped,
  remotePitch,
  RESET_AND_SWAP_REPORT,
  scoringSwapFixture
} from '../../../rigs/scoringLayout'
import { freshReading, type Reading } from '../../../rigs/scoringViewport'
import {
  hideSafariToolbar,
  nativeFooterRows,
  reopenSafariToolbar,
  signInViewportScorer,
  tapViewportBall
} from '../../../rigs/scoringViewportPhone'

const grass = 'rgb(79, 121, 56)'
const COVER = 'Rotate to portrait to continue scoring.'

/**
 * Chrome folds its toolbar only while a page scrolls. The scoring page is
 * fixed at 100svh and never scrolls, so on it Chrome's toolbar stays shown
 * after the swipe: the collapsed state does not exist there.
 * Whether the swipe folded it, from readings over the next three seconds.
 */
async function chromeFolded(
  read: () => Promise<Reading>,
  expanded: Reading
): Promise<boolean> {
  for (const until = Date.now() + 3000; Date.now() < until;) {
    const r = await read()
    if (r.bottom - r.top > expanded.bottom - expanded.top + 8) return true
    await pause(500)
  }
  return false
}
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** In the bottom 100 physical pixels, the longest level run in each
 * off-centre column is the background behind icons and the home indicator. */
function footColours(png: PNG, rows: number): number[][] {
  if (rows === 0) return []
  return [0.12, 0.3, 0.7, 0.88].map(fraction => {
    let longest = 0
    let result: number[] = []
    let anchor: number[] = []
    let length = 0
    for (let y = png.height - 1; y >= Math.max(0, png.height - rows); y--) {
      const i = 4 * (png.width * y + Math.floor(fraction * png.width))
      const rgb = Array.from(png.data.subarray(i, i + 3))
      if (!rgb.every((v, j) => Math.abs(v - anchor[j]) <= 5)) {
        anchor = rgb
        length = 0
      }
      if (++length > longest) {
        longest = length
        result = anchor
      }
    }
    return result
  })
}

async function bottomStrip(ctx: E2eContext): Promise<void> {
  const faults =
    ctx.stack.attached == null
      ? undefined
      : requireDropletHandle(ctx.stack.attached).faults
  if (faults == null)
    throw new Error('The phone readings need the isolated stack')
  const { platform, appId } = browserAppOf(ctx.surface)
  const ios = platform === 'ios'
  const layout = process.env.TS_SCORING_TOOLBAR_LAYOUT
  if (!(ios ? ['top', 'bottom', 'compact'] : ['bottom']).includes(layout ?? ''))
    throw new Error('Set TS_SCORING_TOOLBAR_LAYOUT to the browser setting')
  const m = await ctx.attach('phone', { platform, appId })
  await m.launchApp({ appId, stopApp: false })
  // A phone browser held sideways is covered until it is turned upright
  // (RotateToPortrait, E2), so the toolbar is read in portrait only.
  const orientations = ['PORTRAIT']
  const origin = ctx.stack.origin
  // Unknown until the first swipe on Chrome; Safari folds by its own menu.
  let folds: boolean | undefined = ios ? true : undefined
  try {
    for (const orientation of orientations) {
      for (const state of ['expanded', 'collapsed', 'expanded-again']) {
        if (state !== 'expanded' && folds === false) continue
        const world = await scoringSwapFixture(ctx)
        const run = randomUUID()
        const fresh = freshReading(faultControl(faults), run)
        await m.setOrientation({ orientation: 'PORTRAIT' })
        await clearSignInLimits(ctx)
        await signInViewportScorer(ctx, m, world.accounts.scorekeeper)
        await m.openLink({
          link: `${origin}/viewportProbe/scoring.html?run=${run}&game=${world.ids.game}`,
          browser: true
        })
        await m.setOrientation({ orientation })
        const turned = (r: Reading): boolean =>
          orientation === 'PORTRAIT' ? r.small > r.width : r.small < r.width
        const expanded = await fresh('scoring', turned)
        const peer = await remotePitch(ctx, world)
        try {
          await peer.pitch()
          await fresh(
            'scoring',
            r => turned(r) && (r.log != null || (r.logBand?.height ?? 0) < 64)
          )
          if (state !== 'expanded') {
            await m.swipe({ start: '50%,65%', end: '50%,25%' })
            if (
              ios &&
              (await fresh('scoring', turned)).bottom <= expanded.bottom + 8
            ) {
              await hideSafariToolbar(m)
            }
            if (
              !ios &&
              !(await chromeFolded(
                async () => await fresh('scoring', turned),
                expanded
              ))
            ) {
              folds = false
              writeFileSync(
                ctx.artifact('chrome-toolbar-stays.png'),
                await m.screenshot()
              )
              writeFileSync(
                ctx.artifact('chrome-toolbar-stays.json'),
                JSON.stringify(
                  {
                    folded: false,
                    expanded,
                    afterSwipe: await fresh('scoring', turned)
                  },
                  null,
                  2
                )
              )
              continue
            }
            await fresh(
              'scoring',
              r =>
                turned(r) &&
                r.bottom - r.top > expanded.bottom - expanded.top + 8
            )
            if (state === 'expanded-again') {
              for (let i = 0; i < 2; i++)
                await m.swipe({ start: '50%,30%', end: '50%,75%' })
              if (
                ios &&
                (await fresh('scoring', turned)).bottom > expanded.bottom + 8
              )
                await reopenSafariToolbar(m, orientation === 'PORTRAIT', layout)
              await fresh(
                'scoring',
                r =>
                  turned(r) &&
                  Math.abs(
                    r.bottom - r.top - (expanded.bottom - expanded.top)
                  ) <= 2
              )
            }
          }
          const before = await fresh('scoring', turned)
          const key = [layout, orientation, state].join('-')
          writeFileSync(ctx.artifact(key + '-field.png'), await m.screenshot())
          // Reset from the second scorer so opening menus cannot change the phone toolbar.
          await peer.swap()
          const during = await fresh(
            'scoring',
            r =>
              turned(r) &&
              r.noticeText === RESET_AND_SWAP_REPORT &&
              Math.abs((r.notice?.bottom ?? 0) - (r.root?.bottom ?? -100)) <= 1
          )
          expect(during.deck).deep.equals(before.deck)
          expect(during.logBand).deep.equals(before.logBand)
          expect(during.bottom).closeTo(before.bottom, 1)
          expect(during.notice!.bottom).at.most(during.bottom + 1)
          expect(during.noticeTextBottom!).at.most(
            during.notice!.bottom - during.insets[2] + 1
          )
          const png = await m.screenshot()
          writeFileSync(ctx.artifact(key + '-notice.png'), png)
          writeFileSync(
            ctx.artifact(key + '-notice.json'),
            JSON.stringify({ before, during }, null, 2)
          )
          if (
            ios &&
            layout === 'bottom' &&
            orientation === 'PORTRAIT' &&
            state === 'expanded'
          )
            writeFileSync(ctx.artifact('safari-notice-after.png'), png)
          await expectSwapped(ctx, world)
        } finally {
          await peer.close()
        }
      }
    }
  } finally {
    await m.setOrientation({ orientation: 'PORTRAIT' })
    await m.openLink({ link: origin, browser: true })
  }
}

export default defineE2e({
  id: 'platform/web/scoring-viewport',
  title: 'Scoring fits above the phone browser toolbar as it folds and opens',
  kind: 'e2e',
  covers: [
    'src/app/field/useFieldSurface.ts',
    'src/app/web/index.html',
    'src/app/field/BaseballScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios'], hardware: 'required' }]
    },
    'web-chrome-android': {
      devices: [{ role: 'phone', needs: ['android'], hardware: 'required' }]
    }
  },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'bottom-strip': bottomStrip,
    'above-toolbar': async ctx => {
      const stack =
        ctx.stack.attached == null
          ? undefined
          : requireDropletHandle(ctx.stack.attached)
      if (stack?.faults == null)
        throw new Error(
          'Use the isolated stack with the forwarded-request observer'
        )
      const origin = ctx.stack.origin
      const control = faultControl(stack.faults)
      const run = randomUUID()
      const world = await ctx.fixture('coach-game')
      const { platform, appId } = browserAppOf(ctx.surface)
      const ios = platform === 'ios'
      const layout = process.env.TS_SCORING_TOOLBAR_LAYOUT
      if (
        !(ios ? ['compact', 'bottom', 'top'] : ['bottom']).includes(
          layout ?? ''
        )
      )
        throw new Error(
          'Set TS_SCORING_TOOLBAR_LAYOUT to the current browser toolbar setting'
        )
      const m = await ctx.attach('phone', { platform, appId })
      await m.launchApp({ appId, stopApp: false })
      // A phone browser held sideways is covered until it is turned upright
      // (RotateToPortrait, E2), so the toolbar is read in portrait only.
      const orientations = ['PORTRAIT']
      const results: Record<
        string,
        { reading: Reading; colours: number[][]; footerRows: number }
      > = {}
      const fresh = freshReading(control, run)
      let documentId: string | undefined
      // Whether Chrome's toolbar folds on the scoring page, from its swipe.
      let folds: boolean | undefined = ios ? true : undefined
      const game = world.ids.game
      try {
        await m.setOrientation({ orientation: 'PORTRAIT' })
        await clearSignInLimits(ctx)
        await signInViewportScorer(ctx, m, world.accounts.scorekeeper)
        const token = await signInTestAccount(
          origin + '/api/v1',
          world.accounts.coach
        )
        const balls = async (): Promise<number> => {
          const events = await readJson(
            origin,
            `/api/v1/games/${game}/events`,
            { headers: { authorization: 'Bearer ' + token } }
          )
          return [...JSON.stringify(events).matchAll(/"call":\{"code":"B"/g)]
            .length
        }
        for (const channel of ['scoring', 'reference']) {
          await m.setOrientation({ orientation: 'PORTRAIT' })
          const url = new URL('/viewportProbe/' + channel + '.html', origin)
          url.searchParams.set('run', run)
          url.searchParams.set('game', game)
          await m.openLink({ link: url.toString(), browser: true })
          for (const orientation of orientations) {
            await m.setOrientation({ orientation })
            const portrait = orientation === 'PORTRAIT'
            const turned = (r: Reading): boolean =>
              portrait ? r.small > r.width : r.small < r.width
            const grab = async (
              state: string,
              match: (r: Reading) => boolean = () => true
            ): Promise<Reading> => {
              const r = await fresh(channel, r => turned(r) && match(r))
              const key = [channel, layout, orientation, state].join('-')
              const png = Buffer.from(await m.screenshot())
              writeFileSync(ctx.artifact(key + '.png'), png)
              const pixels = PNG.sync.read(png)
              const scoringKey = ['scoring', layout, orientation, state].join(
                '-'
              )
              const footerRows =
                channel === 'scoring'
                  ? await nativeFooterRows(m, pixels, r)
                  : results[scoringKey].footerRows
              const colours = footColours(pixels, footerRows)
              results[key] = { reading: r, colours, footerRows }
              writeFileSync(
                ctx.artifact('toolbar-layout.json'),
                JSON.stringify(results, null, 2) + '\n'
              )
              if (channel === 'scoring') {
                documentId ??= r.documentId
                expect(
                  r.documentId,
                  'same scoring page across rotation'
                ).equals(documentId)
                const { root, strip, deck } = r
                if (root == null || strip == null || deck == null)
                  throw new Error('Missing scoring geometry')
                expect(root.height, 'small viewport').closeTo(r.small, 1)
                expect(strip.bottom, 'strip at root foot').closeTo(
                  root.bottom,
                  1
                )
                expect(deck.height, 'whole pitch deck').closeTo(120, 1)
                expect(deck.top).at.least(r.top - 1)
                expect(deck.bottom).at.most(strip.top + 1)
                expect(strip.bottom).at.most(r.bottom + 1)
                expect(r.catcher, 'catcher above controls').at.most(
                  deck.top + 1
                )
                if (r.log != null) {
                  expect(r.log.top).at.least(deck.bottom - 1)
                  expect(r.log.bottom).at.most(strip.top + 1)
                }
                expect(r.page).equals(grass)
                if (r.bottom > root.bottom + 2)
                  expect(r.exposed, 'revealed field colour').equals(grass)
                if (ios && layout === 'bottom' && state === 'expanded')
                  writeFileSync(
                    ctx.artifact(
                      portrait
                        ? 'safari-bottom-after.png'
                        : 'iphone15-safari-landscape-after.png'
                    ),
                    png
                  )
              } else {
                const actual =
                  results[['scoring', layout, orientation, state].join('-')]
                    .colours
                for (const [i, rgb] of colours.entries())
                  expect(
                    actual[i].every((c, j) => Math.abs(rgb[j] - c) <= 16),
                    'bottom background matches the same toolbar over grass'
                  ).equals(true)
              }
              return r
            }
            /**
             * Turned sideways, the browser shows the rotate-to-portrait cover
             * and a tap where Ball was does not score; upright again, the
             * same page (no reload) lays out as before and Ball scores.
             */
            const sidewaysCover = async (at: string): Promise<void> => {
              if (at !== 'scoring') return
              const before = await balls()
              await m.setOrientation({ orientation: 'LANDSCAPE_LEFT' })
              await m.assertVisible({ text: COVER, timeout: 15000 })
              await pause(1000)
              const png = Buffer.from(await m.screenshot())
              writeFileSync(
                ctx.artifact(
                  ['scoring', layout, 'LANDSCAPE', 'cover'].join('-') + '.png'
                ),
                png
              )
              if (ios && layout === 'bottom')
                writeFileSync(
                  ctx.artifact('iphone15-safari-landscape-after.png'),
                  png
                )
              // Where Ball sits under the cover, and the middle of the
              // screen: each is a touch on the cover.
              await tapViewportBall(m, ios).catch(() => undefined)
              await m.tapOn({ point: '50%,50%' })
              await pause(3000)
              expect(await balls(), 'the cover takes the Ball tap').equals(
                before
              )
              await m.setOrientation({ orientation: 'PORTRAIT' })
              await m.assertNotVisible({ text: COVER, timeout: 15000 })
              // grab checks the same document, the deck and the strip, once
              // the toolbar is back to its expanded height.
              await grab(
                'upright-again',
                r =>
                  Math.abs(
                    r.bottom - r.top - (expanded.bottom - expanded.top)
                  ) <= 2
              )
              await tapViewportBall(m, ios)
              for (
                const until = Date.now() + 20000;
                (await balls()) === before && Date.now() < until;
              )
                await pause(500)
              expect(await balls(), 'Ball scores upright again').equals(
                before + 1
              )
            }
            const expanded = await grab('expanded')
            if (channel === 'scoring') {
              const before = await balls()
              await tapViewportBall(m, ios)
              for (
                const until = Date.now() + 20000;
                (await balls()) === before && Date.now() < until;
              )
                await pause(500)
              expect(await balls(), 'one more Ball persisted').equals(
                before + 1
              )
            }
            if (folds === false) {
              await sidewaysCover(channel)
              continue
            }
            await m.swipe({ start: '50%,65%', end: '50%,25%' })
            if (
              ios &&
              (await fresh(channel, turned)).bottom <= expanded.bottom + 8
            ) {
              // A fixed scoring page does not scroll. Safari's own menu
              // can hide its bars on such a page.
              await hideSafariToolbar(m)
            }
            if (
              folds === undefined &&
              !(folds = await chromeFolded(
                async () => await fresh(channel, turned),
                expanded
              ))
            ) {
              // The toolbar stayed: still the expanded layout, recorded as
              // what a swipe leaves on Chrome.
              await grab(
                'swipe-stays-expanded',
                r =>
                  Math.abs(
                    r.bottom - r.top - (expanded.bottom - expanded.top)
                  ) <= 2
              )
              await sidewaysCover(channel)
              continue
            }
            await grab(
              'collapsed',
              r => r.bottom - r.top > expanded.bottom - expanded.top + 8
            )
            for (let i = 0; i < 2; i++)
              await m.swipe({ start: '50%,30%', end: '50%,75%' })
            if (
              ios &&
              (await fresh(channel, turned)).bottom > expanded.bottom + 8
            )
              await reopenSafariToolbar(m, orientation === 'PORTRAIT', layout)
            await grab(
              'expanded-again',
              r =>
                Math.abs(r.bottom - r.top - (expanded.bottom - expanded.top)) <=
                2
            )
            await sidewaysCover(channel)
          }
        }
      } finally {
        writeFileSync(
          ctx.artifact('toolbar-layout.json'),
          JSON.stringify(results, null, 2) + '\n'
        )
        await m.setOrientation({ orientation: 'PORTRAIT' })
        await m.openLink({ link: origin, browser: true })
      }
    }
  }
})
