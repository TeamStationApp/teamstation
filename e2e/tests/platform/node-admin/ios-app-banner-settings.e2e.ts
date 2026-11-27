import { expect } from 'chai'

import type { NodeSettings } from '../../../../src/common/nodeSettings'
import { eventually } from '../../../core/readback'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { bannerBrowserCoverage } from '../../../rigs/iosAppBannerCoverage'
import {
  apiClient,
  byLabel,
  byLabelStart
} from '../../../rigs/search/searchRig'

const label = 'iOS App Store link'
const size = { width: 960, height: 740 }
const listing =
  'https://apps.apple.com/us/app/teamstation/id6824597245/?source=web#id000'
const replacement = 'https://apps.apple.com/app/id001234'

async function visit(
  session: WebSession,
  address: string,
  appId: string | null,
  requests: number
): Promise<void> {
  await session.m.openLink({ link: address })
  await session.m.assertVisible({
    text: 'Use a password instead',
    timeout: 60000
  })
  const actual = await session.page.evaluate(() => ({
    tags: Array.from(
      document.head.querySelectorAll('meta[name="apple-itunes-app"]'),
      tag => tag.getAttribute('content')
    ),
    requests: performance
      .getEntriesByType('resource')
      .filter(entry =>
        new URL(entry.name).pathname.endsWith('/node/ios-app-banner')
      ).length
  }))
  expect(actual).deep.equals({
    tags: appId == null ? [] : ['app-id=' + appId],
    requests
  })
  console.log(
    `Safari metadata: ${actual.tags.length > 0 ? actual.tags.join(', ') : 'no tag'}, ${requests} request(s)`
  )
}

/** Keep the metadata off the wire until after the browser has parsed the body. */
async function visitWithStalledBanner(
  session: WebSession,
  address: string
): Promise<void> {
  const cdp = await session.page.createCDPSession()
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/node/ios-app-banner', resourceType: 'Stylesheet' }
    ]
  })
  let pausedAt = 0
  cdp.on('Fetch.requestPaused', () => {
    pausedAt = performance.now()
  })
  const opened: Promise<void> = session.m.openLink({ link: address })
  try {
    await eventually(async () => {
      expect(pausedAt).greaterThan(0)
    })
    await session.page.waitForFunction(
      () => document.getElementById('root') != null,
      { timeout: 3500 }
    )
    expect(performance.now() - pausedAt).lessThan(3500)
    expect(await session.page.$('meta[name="apple-itunes-app"]')).equals(null)
  } finally {
    await cdp.detach()
    await opened
  }
  await session.m.assertVisible({
    text: 'Use a password instead',
    timeout: 60000
  })
}

async function browserAs(
  ctx: E2eContext,
  device: string,
  platform: string,
  touches: number
): Promise<WebSession> {
  const userAgent = `Mozilla/5.0 (${device}) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1`
  const beforeLoad = Object.entries({
    userAgent,
    platform,
    maxTouchPoints: touches
  })
    .map(
      ([key, value]) =>
        `Object.defineProperty(navigator, ${JSON.stringify(key)}, { value: ${JSON.stringify(value)} });`
    )
    .join('\n')
  return await ctx.browser(size, { beforeLoad })
}

export default defineE2e({
  id: 'platform/node-admin/ios-app-banner-settings',
  title: 'The saved App Store link controls the next eligible page load',
  kind: 'e2e',
  covers: [
    'src/app/screens/NodeSettingsCard.tsx',
    'src/app/web/iosAppBanner.ts',
    'src/server/nodeSettings.ts',
    'src/build.mjs'
  ],
  stack: 'isolated',
  fixtures: ['search'],
  exclusive: true,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'saved-setting': async ctx => {
      const fixture = await ctx.fixture('search')
      const admin = await apiClient(ctx, fixture.accounts.nodeAdmin)
      const original: NodeSettings = await admin.nodeSettings()
      const coverage = bannerBrowserCoverage(ctx.stack.origin)
      const { m, page } = await coverage.watch(await ctx.browser(size))
      const node = ctx.stack.origin + '/node'
      const address = ctx.stack.origin + '/sign-in'
      const row = { css: byLabelStart(label + ': ') }
      const scroll = async (
        element: { css: string } | { text: string }
      ): Promise<void> => {
        // The card is longer than ten scrolls since the sponsor settings:
        // bring the target near first, once the card has drawn it. (No `?.`
        // or `??` in here: the spec's compiler turns them into helpers the
        // page does not have.)
        await page.waitForFunction(
          (css: string | null, text: string | null) => {
            let target: Element | null = null
            if (css != null) target = document.querySelector(css)
            else if (text != null) {
              const pattern = new RegExp(text)
              const nodes = document.querySelectorAll('*')
              for (let i = 0; i < nodes.length && target == null; i++) {
                const node = nodes[i]
                if (
                  node.children.length === 0 &&
                  pattern.test(String(node.textContent).trim())
                )
                  target = node
              }
            }
            if (target == null) return false
            target.scrollIntoView({ block: 'center' })
            return true
          },
          { timeout: 60000 },
          'css' in element ? element.css : null,
          'text' in element ? element.text : null
        )
        const above =
          'css' in element &&
          (await page.evaluate(css => {
            const target = document.querySelector(css)
            return target != null && target.getBoundingClientRect().top < 0
          }, element.css))
        await m.scrollUntilVisible({
          element,
          direction: above ? 'UP' : 'DOWN',
          centerElement: true,
          timeout: 60000
        })
      }
      const field = 'input' + byLabel(label)
      const held = async (): Promise<string> =>
        await page.$eval(field, one => (one as HTMLInputElement).value)
      const edit = async (value: string): Promise<void> => {
        await m.tapOn({ css: field })
        // The whole link selected and deleted, then typed, until the field
        // holds it: a key at a time, erasing and typing dropped keys on a
        // busy stack.
        await eventually(async () => {
          if ((await held()).length > 0) {
            await page.$eval(field, one => {
              ;(one as HTMLInputElement).select()
            })
            await m.pressKey({ key: 'Backspace' })
          }
          expect(await held(), 'Erased link').equals('')
          if (value.length > 0) await m.inputText({ text: value })
          const typed = await held()
          expect(typed, 'Typed link: ' + typed).equals(value)
        }, 30000)
        await m.tapOn({ text: '^Use$' })
      }
      const save = async (expected: string): Promise<void> => {
        await scroll({ text: '^Save$' })
        await m.tapOn({ text: '^Save$' })
        await eventually(async () => {
          const saved: string = (await admin.nodeSettings()).distribution
            .iosAppStoreUrl
          expect(saved, 'Stored link: ' + saved).equals(expected)
        })
      }
      try {
        await admin.setNodeSettings({
          ...original,
          distribution: { ...original.distribution, iosAppStoreUrl: '' }
        })
        await m.openLink({ link: address })
        await ctx.signIn('nodeAdmin', m)
        await m.openLink({ link: node })
        await scroll(row)
        await m.takeScreenshot({ path: ctx.artifact('admin-links-after.png') })
        await m.tapOn(row)
        const invalid = 'https://example.test/app/id123'
        await edit(invalid)
        await m.assertVisible({ text: 'iOS App Store link must be.*' })
        await m.takeScreenshot({
          path: ctx.artifact('admin-validation-after.png')
        })
        expect((await admin.nodeSettings()).distribution.iosAppStoreUrl).equals(
          ''
        )
        await edit(listing)
        await save(listing)
        await m.openLink({ link: node })
        await scroll(row)
        await m.assertVisible({ css: byLabel(label + ': ' + listing) })
        const pitch = original.radar.pitchWindowSec === 4 ? 3 : 4
        const radar = { css: byLabelStart('Radar pitch window: ') }
        await scroll(radar)
        await m.tapOn(radar)
        await m.tapOn({
          css: byLabel(`Pitch window (before and after) ${pitch} s`)
        })
        await m.tapOn({ text: '^Use$' })
        await save(listing)
        await eventually(async () => {
          expect((await admin.nodeSettings()).radar.pitchWindowSec).equals(
            pitch
          )
        })
        await m.openLink({ link: node })
        await scroll(radar)
        await m.assertVisible({
          css: byLabel(`Radar pitch window: ${pitch} s`)
        })
        await scroll(row)
        await m.assertVisible({ css: byLabel(label + ': ' + listing) })
        const phone = await coverage.watch(
          await browserAs(ctx, 'iPhone', 'iPhone', 5)
        )
        await visit(phone, address, '6824597245', 1)
        await visitWithStalledBanner(
          await coverage.watch(await browserAs(ctx, 'iPhone', 'iPhone', 5)),
          address
        )
        for (const [identity, platform, touches, expected] of [
          ['Macintosh', 'MacIntel', 5, '6824597245'],
          ['Macintosh', 'MacIntel', 0, null],
          ['Linux; Android', 'Linux', 5, null]
        ] as const) {
          console.log(`Checking ${identity}, ${touches} touches`)
          await visit(
            await coverage.watch(
              await browserAs(ctx, identity, platform, touches),
              expected == null ? 'skipped' : undefined
            ),
            address,
            expected,
            expected == null ? 0 : 1
          )
        }
        for (const [value, id] of [
          [replacement, '001234'],
          ['', null]
        ] as const) {
          await scroll(row)
          await m.tapOn(row)
          await edit(value)
          await save(value)
          await visit(phone, address, id, 1)
        }
        await ctx.checkpoint(
          'cleared-setting',
          {
            readBack: async () => {
              expect(
                (await admin.nodeSettings()).distribution.iosAppStoreUrl
              ).equals('')
            }
          },
          m
        )
      } finally {
        const settings: NodeSettings = await admin.nodeSettings()
        await admin.setNodeSettings({
          ...settings,
          distribution: original.distribution,
          radar: original.radar
        })
        await coverage.finish()
      }
    }
  }
})
