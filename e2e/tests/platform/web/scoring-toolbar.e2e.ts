import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import { signInTestAccount } from '../../../../src/test/passwordFixtures'
import { faultControl, requireDropletHandle } from '../../../core/dropletStack'
import { readJson } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import { browserAppOf } from '../../../rigs/mobileWeb'
import {
  hideSafariToolbar,
  reopenSafariToolbar,
  signInViewportScorer
} from '../../../rigs/scoringViewportPhone'

interface Box {
  top: number
  bottom: number
  height: number
}
interface Reading {
  documentId: string
  width: number
  small: number
  top: number
  bottom: number
  root?: Box
  strip?: Box
  deck?: Box
  catcher?: number
  log?: Box
  page: string
  exposed?: string | null
  insets: number[]
}
const grass = 'rgb(79, 121, 56)'
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** In the bottom 100 physical pixels, the longest level run in each
 * off-centre column is the background behind icons and the home indicator. */
function footColours(png: PNG): number[][] {
  return [0.12, 0.3, 0.7, 0.88].map(fraction => {
    let longest = 0
    let result: number[] = []
    let anchor: number[] = []
    let length = 0
    for (let y = png.height - 1; y >= Math.max(0, png.height - 100); y--) {
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
      const orientations =
        process.env.TS_SCORING_PORTRAIT_ONLY === '1'
          ? ['PORTRAIT']
          : ['PORTRAIT', 'LANDSCAPE_LEFT']
      const results: Record<string, { reading: Reading; colours: number[][] }> =
        {}
      const originPath = `/api/v1/viewport-observation/${run}/`
      const fresh = async (
        channel: string,
        widthCheck: (r: Reading) => boolean
      ): Promise<Reading> => {
        const prefix = originPath + channel + '/'
        const rows = async (): Promise<Array<{ at: number; path: string }>> => {
          const rows = (await control.call(
            'GET',
            'requests?path=' + encodeURIComponent(prefix)
          )) as { requests: Array<{ at: number; path: string }> }
          return rows.requests
        }
        const previous = (await rows()).at(-1)?.at ?? 0
        for (const end = Date.now() + 15000; Date.now() < end;) {
          await pause(400)
          const row = (await rows()).at(-1)
          if (row == null || row.at <= previous) continue
          const measurement = JSON.parse(
            Buffer.from(row.path.slice(prefix.length), 'base64url').toString()
          ) as Reading
          if (widthCheck(measurement)) return measurement
        }
        throw new Error(
          `No fresh ${channel} geometry; stage e2e/fixtures/viewportProbe/stage.mjs on the isolated web build`
        )
      }
      let documentId: string | undefined
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
              const colours = footColours(PNG.sync.read(png))
              results[key] = { reading: r, colours }
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
            const expanded = await grab('expanded')
            await m.swipe({ start: '50%,65%', end: '50%,25%' })
            if (
              ios &&
              (await fresh(channel, turned)).bottom <= expanded.bottom + 8
            ) {
              // A fixed scoring page does not scroll. Safari's own menu
              // can hide its bars on such a page.
              await hideSafariToolbar(m)
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
            if (channel === 'scoring') {
              const before = await balls()
              await m.tapOn({ text: '^Ball$', below: { text: 'MORE' } })
              for (
                const until = Date.now() + 20000;
                (await balls()) === before && Date.now() < until;
              )
                await pause(500)
              expect(await balls(), 'one more Ball persisted').equals(
                before + 1
              )
            }
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
