/* eslint-disable @typescript-eslint/prefer-optional-chain, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e, type E2eContext } from '../../../core/spec'
import {
  FIELD,
  MIC,
  pause,
  TESS_GOLDEN,
  TESS_WEB_SPEC,
  type TessWeb,
  THINKING,
  withTess
} from '../../../rigs/tessWeb'

/**
 * Space held to talk to Tess. maestro-d's `pressKey` is a whole press with the real
 * key, which is what a quick Space is. It has no key held down, so a hold is the same
 * key events sent through the page; the app treats them alike, and holds back the key's
 * default either way, so nothing here depends on the browser's own Space but the
 * scroll with push-to-talk off, which uses `pressKey`.
 */

/** Sends one Space event to what has the focus. */
async function space(web: TessWeb, type: 'keydown' | 'keyup'): Promise<void> {
  await web.m.evalBrowserScript({
    script: `(document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent(${JSON.stringify(type)}, { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    )`
  })
}

/** The pane's Team or Schedule tab, never the navigation sidebar's. */
function paneTab(name: string): string {
  return `[role="tab"][aria-label="${name}"]:not([data-testid="navigation-sidebar"] *)`
}

/**
 * The pane's tallest scroller with room to scroll: the navigation's scenes,
 * between the sidebar and her column on the right (fb5ef504a), what is in
 * them, or what holds them short of the sidebar. On a wide window the
 * scenes scroll as one, header and all.
 */
const findScroller = `(() => {
  const scenes = document.querySelector('[data-testid="navigation-scenes"]')
  if (scenes == null) return undefined
  const around = []
  for (let node = scenes.parentElement; node != null && node.querySelector('[data-testid="navigation-sidebar"]') == null; node = node.parentElement) around.push(node)
  return [scenes, ...around, ...Array.from(scenes.querySelectorAll('*'))]
})()
  ?.filter(candidate => {
    const style = getComputedStyle(candidate)
    return (
      ['auto', 'scroll'].includes(style.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight + 200
    )
  })
  .sort((a, b) => b.clientHeight - a.clientHeight)[0]`

/** Puts the pane's scroller at the top and marks it for the reads after. */
async function scrollPaneToTop(web: TessWeb): Promise<void> {
  await eventually(async () => {
    await web.m.evalBrowserScript({
      script: `document.querySelector('[data-space-scroller]')?.removeAttribute('data-space-scroller')
        const node = ${findScroller}
        if (node != null) { node.setAttribute('data-space-scroller', ''); node.scrollTop = 0 }`
    })
    expect(await paneScrollTop(web), 'the pane can scroll').equals(0)
    // The list scrolls itself to its next game once it has settled.
    await pause(1500)
    expect(await paneScrollTop(web), 'the pane stayed put').equals(0)
  }, 20000)
}

async function paneScrollTop(web: TessWeb): Promise<number> {
  return await web.page.evaluate(() => {
    const node = document.querySelector('[data-space-scroller]')
    return node == null || !node.isConnected ? -1 : node.scrollTop
  })
}

/**
 * The team's Schedule tab, long enough to scroll, beside her microphone.
 * The header's and the navigation sidebar's Schedule are the same label,
 * and they leave the team, so the press is the pill in the page, the one
 * whose words are Schedule.
 */
async function schedule(web: TessWeb): Promise<void> {
  await web.open('/')
  await web.openChat()
  await web.goInApp(`/teams/${web.t.f.teamA}`)
  await web.shown('Demo Hawks')
  let point: { x: number; y: number } | null = null
  await eventually(async () => {
    point = await web.page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
      const pill = tabs.find(node => {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        const label = node.getAttribute('aria-label') || ''
        const box = node.getBoundingClientRect()
        return (
          box.y > 120 &&
          box.width > 0 &&
          node.closest('[data-testid="navigation-sidebar"]') == null &&
          (text === 'Schedule' || label === 'Schedule')
        )
      })
      if (pill == null) return null
      const box = pill.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    expect(point, 'the team Schedule pill').not.equals(null)
  }, 15000)
  await web.m.tapOnPoint({
    x: Math.round(point!.x),
    y: Math.round(point!.y)
  })
  await web.shown('to play')
  await scrollPaneToTop(web)
}

/**
 * Space held 800 ms while the microphone hears a sentence: not listening at 300 ms,
 * listening from 500, and what was heard left in the field. Sending it is a
 * separate press, which is what makes the message. Returns when it began listening.
 */
async function holdAndHear(web: TessWeb): Promise<number> {
  const { HEARD } = await import('../../../../src/test/tessFixture')
  const heardBefore = await web.userBubbles(HEARD)
  const down = Date.now()
  await space(web, 'keydown')
  const playing = web.page.evaluate(async () => {
    await (window as any).__playClip()
  })
  await pause(300)
  expect(await web.dictationStatus(), 'not yet at 300 ms').equals('Off')
  await web.waitForStatus('Recording', 2000)
  const listening = Date.now() - down
  expect(listening, 'listening from 500 ms').greaterThanOrEqual(500)
  await pause(Math.max(0, 800 - (Date.now() - down)))
  await space(web, 'keyup')
  await playing
  await eventually(async () => {
    expect(await web.fieldValue()).equals(HEARD)
  }, 30000)
  expect(await web.userBubbles(HEARD), 'a hold does not send').equals(
    heardBefore
  )
  await web.m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    expect(await web.userBubbles(HEARD)).greaterThan(heardBefore)
  }, 30000)
  await web.gone(THINKING)
  return listening
}

/**
 * The focus on the pane's page itself: a press on text in the pane's scroller that
 * nothing focusable holds, then nothing focused.
 */
async function focusPage(web: TessWeb): Promise<void> {
  const point = await web.page.evaluate(() => {
    const scroller = document.querySelector('[data-space-scroller]')
    if (scroller == null) return null
    const focusable =
      'a, button, input, textarea, select, [tabindex], [role="button"], [role="tab"], [role="link"]'
    // The tabs lie side by side, so only what is inside the scroller's own box is
    // on the screen.
    const pane = scroller.getBoundingClientRect()
    const text = Array.from(scroller.querySelectorAll('div, span')).find(
      node => {
        const box = node.getBoundingClientRect()
        return (
          node.children.length === 0 &&
          (node.textContent || '').trim() !== '' &&
          node.closest(focusable) == null &&
          box.width > 0 &&
          box.x >= pane.x &&
          box.x + box.width <= pane.x + pane.width &&
          box.y > 120 &&
          box.y < 600
        )
      }
    )
    if (text == null) return null
    const box = text.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
  expect(point, 'text on the pane to press').not.equals(null)
  await web.m.tapOnPoint({ x: Math.round(point!.x), y: Math.round(point!.y) })
  await web.m.evalBrowserScript({
    script: `const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) active.blur()`
  })
  expect(
    await web.page.evaluate(() => document.activeElement === document.body)
  ).equals(true)
}

/** Runs a scenario beside a long Schedule, with the fake microphone. */
async function beside(
  ctx: E2eContext,
  run: (web: TessWeb) => Promise<void>
): Promise<void> {
  await withTess(
    ctx,
    async web => {
      await schedule(web)
      await run(web)
    },
    { liveClock: true }
  )
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/space-hold',
  title:
    "Space held half a second talks to Tess; a quick press stays the page's, and a tap records until the next tap",
  covers: [
    'src/app/tess/TessPanel.tsx',
    'src/app/scoring/spaceToTalk.ts',
    'src/app/scoring/dictationControls.tsx',
    'src/server/dictation/**'
  ],
  minutes: 2,
  faults: ['socket-drop', 'hidden-element'],
  scenarios: {
    'quick-press-types-a-space': async ctx => {
      await beside(ctx, async web => {
        const { m, t } = web
        const { begun } = t.dictation
        await m.tapOn({ css: FIELD })
        await web.type('a')
        await m.pressKey({ key: 'Space' })
        await web.type('b')
        await eventually(async () => {
          expect(await web.fieldValue()).equals('a b')
        }, 5000)
        await pause(600)
        expect(await web.dictationStatus()).equals('Off')
        expect(t.dictation.begun, 'no utterance started').equals(begun)
        await ctx.checkpoint('field-holds-a-space', {
          expect: [{ id: 'Dictate' }],
          golden: TESS_GOLDEN
        })
      })
    },
    'rolled-press-keeps-the-order': async ctx => {
      await beside(ctx, async web => {
        const { m, t } = web
        const { begun } = t.dictation
        await m.tapOn({ css: FIELD })
        await web.type('hello')
        // Typed fast, Space rolled into the next letter: the letter goes down while
        // Space is still down.
        await space(web, 'keydown')
        await pause(40)
        await web.type('w')
        await space(web, 'keyup')
        await web.type('orld')
        await eventually(async () => {
          expect(await web.fieldValue()).equals('hello world')
        }, 5000)
        await pause(600)
        expect(await web.dictationStatus()).equals('Off')
        expect(t.dictation.begun, 'no utterance started').equals(begun)
        await ctx.checkpoint('field-in-order', { golden: TESS_GOLDEN })
      })
    },
    'held-in-the-field-listens': async ctx => {
      await beside(ctx, async web => {
        const { m, t } = web
        const { begun } = t.dictation
        await m.tapOn({ css: FIELD })
        await holdAndHear(web)
        expect(t.dictation.begun).equals(begun + 1)
        expect(await web.fieldValue()).equals('')
        await ctx.checkpoint('heard-as-a-message', {
          expect: [{ text: "Your team's settings are here" }],
          golden: TESS_GOLDEN
        })
      })
    },
    'quick-press-activates-a-focused-tab': async ctx => {
      await beside(ctx, async web => {
        const { m, page, t } = web
        const { begun } = t.dictation
        await m.evalBrowserScript({
          script: `const seen = { prevented: [] }
            window.__space = seen
            // Whether Space's default survived, read once the key has gone through:
            // the talk key stops it before it bubbles back up.
            window.addEventListener('keydown', event => {
              if (event.code === 'Space')
                setTimeout(() => seen.prevented.push(event.defaultPrevented), 0)
            }, true)`
        })
        let focused = false
        for (let press = 0; press < 80 && !focused; press++) {
          await m.pressKey({ key: 'Tab' })
          focused = await page.evaluate(() => {
            const active = document.activeElement
            return (
              active != null &&
              active.getAttribute('role') === 'tab' &&
              active.getAttribute('aria-label') === 'Team' &&
              active.closest('[data-testid="navigation-scenes"]') != null
            )
          })
        }
        expect(focused, "Tab reached the pane's Team pill").equals(true)
        const topBefore = await paneScrollTop(web)
        await m.pressKey({ key: 'Space' })
        await eventually(async () => {
          expect(
            await page.evaluate(selector => {
              const tab = document.querySelector(selector)
              return tab == null ? null : tab.getAttribute('aria-selected')
            }, paneTab('Team'))
          ).equals('true')
        }, 10000)
        await pause(800)
        const top = await paneScrollTop(web)
        // The Schedule list may have gone with its tab; if it stayed, it did not move.
        if (top !== -1) expect(top, 'Space scrolled nothing').equals(topBefore)
        expect(
          await page.evaluate(() => (window as any).__space.prevented)
        ).deep.equals([true])
        expect(await web.dictationStatus()).equals('Off')
        expect(t.dictation.begun, 'no utterance started').equals(begun)
        await ctx.checkpoint('team-tab-selected', {
          expect: [{ id: 'Dictate' }],
          golden: TESS_GOLDEN
        })
      })
    },
    'held-on-the-page-listens': async ctx => {
      await beside(ctx, async web => {
        const { HEARD } = await import('../../../../src/test/tessFixture')
        const { t } = web
        const { begun } = t.dictation
        await focusPage(web)
        await holdAndHear(web)
        expect(t.dictation.begun).equals(begun + 1)
        expect(t.dictation.heard.at(-1)).equals(HEARD)
        expect(await paneScrollTop(web), 'the hold scrolled nothing').equals(0)
        await ctx.checkpoint('heard-from-the-page', {
          expect: [{ text: HEARD }],
          golden: TESS_GOLDEN
        })
      })
    },
    'a-tap-records-until-the-next-tap': async ctx => {
      await beside(ctx, async web => {
        const { HEARD } = await import('../../../../src/test/tessFixture')
        const { m } = web
        await m.tapOn({ css: MIC })
        await web.waitForStatus('Recording', 5000)
        await m.tapOn({ css: MIC })
        await web.waitForStatus('Off')
        await eventually(async () => {
          expect(await web.fieldValue()).equals(HEARD)
        }, 5000)
        expect(await web.userBubbles(HEARD), 'a tap does not send').equals(0)
        await ctx.checkpoint('tap-heard', {
          expect: [{ text: HEARD }],
          golden: TESS_GOLDEN
        })
      })
    }
  }
})
