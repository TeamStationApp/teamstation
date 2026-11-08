/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  NOTIFICATIONS,
  pause,
  TESS_BUTTON,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

const HEADER_BUTTONS = ['Tess', 'Notifications']

async function headerButtons(web: TessWeb): Promise<string[]> {
  return await web.page.evaluate(
    (wanted: string[]) =>
      Array.from(document.querySelectorAll('[role="button"][aria-label]'))
        .map(node => node.getAttribute('aria-label') || '')
        .filter(label => wanted.includes(label)),
    HEADER_BUTTONS
  )
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/header-button',
  title:
    'The header offers Tess before Notifications, and offers nothing where the server has no Tess',
  covers: [
    'src/app/tess/useTessAvailable.ts',
    'src/app/navigation/**',
    'src/server/routes/tess.ts'
  ],
  minutes: 1,
  faults: ['layout-shift', 'missing-font', 'blank-screen', 'hidden-element'],
  scenarios: {
    'before-notifications': async ctx => {
      await withTess(ctx, async web => {
        // User 101 umpires, so the header has that button too; user 102 does not.
        for (const [user, checkpoint] of [
          [101, 'header-umpire'],
          [102, 'header-member']
        ] as const) {
          await web.identity(user)
          await web.open('/')
          await web.see(NOTIFICATIONS)
          await web.see(TESS_BUTTON)
          // Health is asked once a session is known; give the header that long.
          await pause(1500)
          expect(await headerButtons(web)).deep.equals([
            'Tess',
            'Notifications'
          ])
          await ctx.checkpoint(checkpoint, {
            expect: [{ id: 'Tess' }, { id: 'Notifications' }],
            golden: {}
          })
        }
      })
    },
    'absent-without-tess': async ctx => {
      await withTess(
        ctx,
        async web => {
          await web.open('/')
          await web.see(NOTIFICATIONS)
          // Health is asked once a session is known; give the header that long.
          await pause(2000)
          expect(await web.page.$(TESS_BUTTON)).equals(null)
          await ctx.checkpoint('header-without-tess', {
            expect: [{ id: 'Notifications' }, { id: 'Tess', absent: true }],
            golden: {}
          })
        },
        { fixture: { tess: false } }
      )
    }
  }
})
