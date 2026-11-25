import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { CheckpointSpec, ExpectItem } from '../../../core/checkpoint'
import { eventually } from '../../../core/readback'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'

/**
 * The league administrator's sponsor features demo (#220) on the web: every
 * number comes from the page's own mock store, so each scenario starts from
 * the seeded rows. The stack's `packed-league` has no recordings, so the
 * sample video's place shows "No recording to preview"; the real video is
 * proven on the branch's seat.
 */

const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 375, height: 812 }

/** A 64 × 32 PNG and a JPEG, written into the run at run time. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAN0lEQVR42u3PQQkAAAgEsGtiNOsZ0ww+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQErhZOmzCIkK5iTwAAAABJRU5ErkJggg==',
  'base64'
)
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
)

const ADD_INPUT = '[data-testid="sponsor-drop-zone-input"]'
const DROP_ZONE = '[data-testid="sponsor-drop-zone"]'
const CREDITS_FIELD = 'input[aria-label="Credits for this logo"]'
const PREVIEW = 'sponsor-logo-preview'

const HEADERS = ['Logo', 'Games used', 'Games remaining', 'Action']
const remaining = (left: number): ExpectItem => ({
  text: `Remaining game logo credits: ${left} of 300`
})
const NO_RECORDING: ExpectItem = { text: 'No recording to preview' }

interface Logos {
  web: WebSession
  league: string
}

/**
 * The password form, on a window of any width. `ctx.signIn` waits for the
 * header's TeamStation menu, which a desktop window draws as its sidebar
 * instead, so this waits for the form to go.
 */
async function signInAsAdmin(
  web: WebSession,
  account: { email: string; password: string }
): Promise<void> {
  const { m } = web
  await m.assertVisible({ text: 'Use a password instead', timeout: 30_000 })
  await m.tapOn({ text: 'Use a password instead' })
  await m.tapOn({ css: 'input[aria-label="E-mail address"]', timeout: 15_000 })
  await m.inputText({ text: account.email })
  await m.tapOn({ css: 'input[aria-label="Password"]', timeout: 15_000 })
  await m.inputText({ text: account.password })
  await m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    const signedIn = await web.page.evaluate(
      () => document.querySelector('input[aria-label="Password"]') == null
    )
    expect(signedIn, 'the password form has gone').equals(true)
  }, 30_000)
}

/** Seeds the packed league, signs its admin in, and opens Sponsor Video Logos. */
async function openLogos(
  ctx: E2eContext,
  size: { width: number; height: number }
): Promise<Logos> {
  const world = await ctx.fixture('packed-league')
  const web = await ctx.browser(size)
  await web.m.openLink({ link: ctx.stack.origin })
  await signInAsAdmin(web, world.accounts.admin)
  const league = world.ids.league
  await web.m.openLink({
    link: `${ctx.stack.origin}/groups/league/${encodeURIComponent(league)}/sponsors/logos`
  })
  return { web, league }
}

/**
 * `ctx.checkpoint` with the sample's panel expected too, then the screen
 * it checked kept in the run directory as `<id>.png`.
 */
async function checkpoint(
  ctx: E2eContext,
  web: WebSession,
  id: string,
  spec: CheckpointSpec
): Promise<void> {
  await ctx.checkpoint(id, {
    ...spec,
    expect: [...(spec.expect ?? []), NO_RECORDING]
  })
  await web.m
    .takeScreenshot({ path: ctx.artifact(`${id}.png`) })
    .catch(() => undefined)
}

/** How many logo rows the table lists. */
async function rowCount(web: WebSession): Promise<number> {
  return await web.page.evaluate(
    () => document.querySelectorAll('[data-testid^="sponsor-row-"]').length
  )
}

/**
 * Taps the element at `css` once it is in the middle of the window: on a
 * phone the app's floating bar covers the foot of the page.
 */
async function tapCss(web: WebSession, css: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = document.querySelector(${JSON.stringify(css)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ css, timeout: 15_000 })
}

/** Taps the button reading `label`, once it is in the middle of the window. */
async function tapButton(web: WebSession, label: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = [...document.querySelectorAll('[role="button"]')]
        .find(node => node.textContent === ${JSON.stringify(label)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ text: label, role: 'button', timeout: 15_000 })
}

/** Clears the field at `css` and types `value` into it. */
async function typeInto(
  web: WebSession,
  css: string,
  value: string
): Promise<void> {
  await tapCss(web, css)
  await web.m.eraseText({ characters: 8 }).catch(() => undefined)
  await web.m.inputText({ text: value })
}

/** Taps the confirmation sheet's Deactivate. */
async function confirmDeactivate(web: WebSession): Promise<void> {
  await tapCss(web, '[data-testid="sponsor-confirm-deactivate"]')
}

/** The whole logos flow, on a window of `size`. */
async function logosFlow(
  ctx: E2eContext,
  size: { width: number; height: number }
): Promise<WebSession> {
  const { web } = await openLogos(ctx, size)
  const png = ctx.artifact('sponsor-logo.png')
  const jpeg = ctx.artifact('sponsor-logo.jpg')
  writeFileSync(png, PNG)
  writeFileSync(jpeg, JPEG)

  await checkpoint(ctx, web, 'logos-rows', {
    expect: [
      ...HEADERS.map(text => ({ text, timeout: 30_000 })),
      remaining(120),
      { text: 'Harbor Hardware' },
      { text: 'Inactive' }
    ],
    readBack: async () => {
      expect(await rowCount(web)).equals(3)
    }
  })

  await web.m.uploadFile({ css: ADD_INPUT, path: jpeg, timeout: 15_000 })
  await checkpoint(ctx, web, 'logos-jpeg-refused', {
    expect: [
      { text: 'Logos must be PNG files.' },
      { id: PREVIEW, absent: true }
    ]
  })

  await web.m.uploadFile({ css: ADD_INPUT, path: png, timeout: 15_000 })
  await checkpoint(ctx, web, 'logos-pending', {
    expect: [
      { id: PREVIEW },
      { text: 'Credits for this logo' },
      { text: 'Up to 120 game logo credits left' },
      { text: 'Accept' },
      { text: 'Cancel' }
    ]
  })

  await typeInto(web, CREDITS_FIELD, '50')
  await tapButton(web, 'Accept')
  await checkpoint(ctx, web, 'logos-accepted', {
    expect: [
      remaining(70),
      { text: 'sponsor-logo' },
      { id: PREVIEW, absent: true }
    ],
    readBack: async () => {
      expect(await rowCount(web)).equals(4)
    }
  })

  await typeInto(web, 'input[aria-label="Games allocated, sponsor-logo"]', '60')
  await tapCss(web, '[aria-label="Save games allocated, sponsor-logo"]')
  await checkpoint(ctx, web, 'logos-allocation-saved', {
    expect: [remaining(60)]
  })

  await tapCss(web, '[aria-label="Deactivate Harbor Hardware"]')
  await confirmDeactivate(web)
  await checkpoint(ctx, web, 'logos-harbor-inactive', {
    expect: [remaining(60)],
    readBack: async () => {
      await eventually(async () => {
        // No optional chaining here: the page has no helper for it.
        const harbor = await web.page.evaluate(() => {
          const row = document.querySelector(
            '[data-testid="sponsor-row-logo-harbor-hardware"]'
          )
          return row == null ? '' : String(row.textContent)
        })
        expect(harbor).includes('Inactive')
      }, 10_000)
      expect(await rowCount(web)).equals(4)
    }
  })

  await tapCss(web, '[aria-label="Deactivate sponsor-logo"]')
  await confirmDeactivate(web)
  await checkpoint(ctx, web, 'logos-new-row-removed', {
    expect: [remaining(120), { text: 'sponsor-logo', absent: true }],
    readBack: async () => {
      expect(await rowCount(web)).equals(3)
    }
  })

  // Chromium sends a real drop only from the operating system's own drag,
  // so this is the event the zone listens for.
  await web.m.evalBrowserScript({
    script: `const zone = document.querySelector(${JSON.stringify(DROP_ZONE)})
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}), c => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'dropped-logo.png', { type: 'image/png' }))
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))`
  })
  await checkpoint(ctx, web, 'logos-dropped', {
    expect: [{ id: PREVIEW, timeout: 15_000 }, { text: 'Accept' }]
  })
  await tapButton(web, 'Cancel')
  await checkpoint(ctx, web, 'logos-drop-cancelled', {
    expect: [{ id: PREVIEW, absent: true }, remaining(120)],
    readBack: async () => {
      expect(await rowCount(web)).equals(3)
    }
  })

  await tapButton(web, 'Clear all rows')
  await checkpoint(ctx, web, 'logos-empty', {
    expect: [
      { text: 'No logos yet. Add one above.' },
      { text: 'Games used', absent: true },
      remaining(300)
    ]
  })
  return web
}

/** The page's widest element is no wider than its window. */
async function fitsTheWindow(web: WebSession): Promise<void> {
  const { scrollWidth, innerWidth } = await web.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }))
  expect(scrollWidth, 'no horizontal overflow').at.most(innerWidth)
}

export default defineE2e({
  id: 'schedule/sponsors/admin-demo',
  title:
    'A league administrator previews, accepts, allocates, deactivates and clears sponsor logos on the web, on a desktop and a phone',
  kind: 'e2e',
  covers: [
    'src/app/sponsors/**',
    'src/app/screens/GroupSettingsScreen.tsx',
    'src/app/navigation/routes.ts'
  ],
  stack: 'isolated',
  fixtures: ['packed-league'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 3,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'logos-desktop': async ctx => {
      await logosFlow(ctx, DESKTOP)
    },
    'logos-phone': async ctx => {
      const web = await logosFlow(ctx, PHONE)
      await tapButton(web, 'Reset to sample rows')
      await checkpoint(ctx, web, 'logos-phone-fits', {
        expect: [...HEADERS.map(text => ({ text })), remaining(120)],
        readBack: async () => {
          await fitsTheWindow(web)
        }
      })
    }
  }
})
