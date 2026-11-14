/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  EMBLEMS,
  FIELD,
  TESS_WEB_SPEC,
  type TessWeb,
  THINKING,
  withTess
} from '../../../rigs/tessWeb'

const LIVE = '[data-testid="Tess live reply"]'
const THOUGHT_ROW = '[data-testid="Tess thought"] [role="button"]'
/** Her thought's row says how long it took, so a golden leaves the row out. */
const THOUGHT_MASK = { mask: [{ css: THOUGHT_ROW }, ...EMBLEMS] }

interface Seen {
  thinking: string
  text: string
  steps: string
}

/** What the live reply showed, each time it changed, kept on the page. */
async function watchLiveReply(web: TessWeb): Promise<void> {
  await web.page.evaluate(() => {
    const seen: Seen[] = []
    ;(window as unknown as { tessSeen: Seen[] }).tessSeen = seen
    const record = (): void => {
      const live = document.querySelector('[data-testid="Tess live reply"]')
      if (live == null) return
      const summary = live.querySelector('[data-testid="Tess thought summary"]')
      const text = live.querySelector('[data-testid="Tess live text"]')
      const steps = Array.from(
        live.querySelectorAll('[data-testid="Tess step"]')
      ).map(step =>
        step.querySelector('[data-testid="Tess step done"]') != null
          ? 'done'
          : step.querySelector('[data-testid="Tess step failed"]') != null
            ? 'failed'
            : 'running'
      )
      const now = {
        thinking: summary == null ? '' : summary.textContent || '',
        text: text == null ? '' : text.textContent || '',
        steps: steps.join(',')
      }
      const last = seen[seen.length - 1]
      if (last == null || JSON.stringify(last) !== JSON.stringify(now))
        seen.push(now)
    }
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    })
  })
}

async function thoughtRow(web: TessWeb): Promise<{
  label: string | null
  expanded: string | null
  body: string | null
  steps: Array<string | null>
}> {
  return await web.page.evaluate(() => {
    const replies = document.querySelectorAll('[data-testid="Tess reply"]')
    const reply = replies[replies.length - 1]
    const row = reply.querySelector<HTMLElement>(
      '[data-testid="Tess thought"] [role="button"]'
    )!
    const body = reply.querySelector('[data-testid="Tess thought body"]')
    return {
      label: row.getAttribute('aria-label'),
      expanded: row.getAttribute('aria-expanded'),
      body:
        body == null
          ? null
          : (body.querySelector('[data-testid="Tess thought summary"]') || body)
              .textContent,
      steps: Array.from(
        reply.querySelectorAll('[data-testid="Tess step"]')
      ).map(step => step.getAttribute('aria-label'))
    }
  })
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/streaming-reply',
  title:
    'A reply streams in: her thinking first, each step running then done, her text growing, then a closed thought to open',
  covers: [
    'src/app/tess/TessMessage.tsx',
    'src/app/tess/TessThinking.tsx',
    'src/app/tess/useTess.ts',
    'src/server/tess/turns.ts'
  ],
  minutes: 1,
  faults: ['api-hang', 'api-garbage'],
  scenarios: {
    'thinking-steps-and-text-arrive-in-order': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { m, page } = web
          await web.open('/')
          await web.openChat()
          await watchLiveReply(web)
          await m.tapOn({ css: FIELD })
          await web.type('How did our last two games go?')
          await m.pressKey({ key: 'Enter' })
          await web.see(LIVE)
          await web.gone(THINKING, 40000)
          const seen = await page.evaluate(
            () => (window as unknown as { tessSeen: Seen[] }).tessSeen
          )
          const firstThought = seen.findIndex(state => state.thinking !== '')
          const firstText = seen.findIndex(state => state.text !== '')
          expect(firstThought, 'her thinking shows').greaterThanOrEqual(0)
          expect(firstThought, 'before any of her text').lessThan(firstText)
          // Each step's spinner, then its check, the second after the first.
          const stepStates = seen
            .map(state => state.steps)
            .filter((steps, at, all) => at === 0 || all[at - 1] !== steps)
          const wanted = ['running', 'done', 'done,running', 'done,done']
          let found = 0
          for (const steps of stepStates) {
            if (steps === wanted[found]) found += 1
          }
          expect(found, JSON.stringify(stepStates)).equals(wanted.length)
          // The text grows in place, a few words at a time.
          const grown = seen
            .map(state => state.text)
            .filter((text, at, all) => text !== '' && all[at - 1] !== text)
          expect(grown.length, 'pieces of text').greaterThan(6)
          grown.forEach((text, at) => {
            if (at > 0) {
              expect(
                text.length,
                `${grown[at - 1]} -> ${text}`
              ).greaterThanOrEqual(grown[at - 1].length)
            }
          })
          // Its last piece may come with the stored reply, which takes its place.
          expect(grown[grown.length - 1]).contains('Demo Hawks lost the latest')
          await web.shown('won the one before it 9 to 1.')
          await web.see(THOUGHT_ROW)
          const collapsed = await thoughtRow(web)
          expect(collapsed.label).match(/^Thought for \d+s$/)
          expect(collapsed.expanded).equals('false')
          expect(collapsed.body).equals(null)
          await ctx.checkpoint('thought-collapsed', {
            expect: [{ text: 'won the one before it 9 to 1.' }],
            golden: THOUGHT_MASK
          })
          await web.tap(THOUGHT_ROW)
          await eventually(async () => {
            expect((await thoughtRow(web)).expanded).equals('true')
          }, 10000)
          const expanded = await thoughtRow(web)
          expect(expanded.body).contains('They want their last two games.')
          expect(expanded.body).contains(
            'I will give the scores, newest first.'
          )
          expect(expanded.steps).deep.equals([
            'Reading: Public minimal group profile with optional current management capability, done',
            "Reading: A team's games, newest first, done"
          ])
          await ctx.checkpoint('thought-expanded', {
            expect: [{ text: 'They want their last two games.' }],
            golden: THOUGHT_MASK
          })
        },
        { liveClock: true }
      )
    }
  }
})
