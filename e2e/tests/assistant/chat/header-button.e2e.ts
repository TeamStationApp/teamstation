import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  ASK_TESS,
  MARK_MENU,
  NOTIFICATIONS,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

const ACCOUNT = '[role="button"][aria-label^="Account, "]'
/**
 * The header's mark and menu are below the 1216-point width where the
 * navigation sidebar takes over (develop 30f330991), as develop's own
 * header test draws them.
 */
const HEADER = { width: 1200 }

/** The mark, which offers Tess, sits to the left of the account menu. */
async function markBeforeAccount(web: TessWeb): Promise<void> {
  await web.see(MARK_MENU)
  await web.see(ACCOUNT)
  const before = await web.page.evaluate(
    (mark: string, account: string) => {
      const leftNode = document.querySelector(mark)
      const rightNode = document.querySelector(account)
      const left = leftNode == null ? null : leftNode.getBoundingClientRect().x
      const right =
        rightNode == null ? null : rightNode.getBoundingClientRect().x
      return left != null && right != null && left < right
    },
    MARK_MENU,
    ACCOUNT
  )
  expect(before).equals(true)
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
      await withTess(
        ctx,
        async web => {
          // User 101 umpires, so the header has that button too; user 102 does not.
          for (const [user, checkpoint] of [
            [101, 'header-umpire'],
            [102, 'header-member']
          ] as const) {
            await web.identity(user)
            await web.open('/')
            await markBeforeAccount(web)
            await web.tap(MARK_MENU)
            await web.see(ASK_TESS)
            await web.tap('[role="button"][aria-label="Close menu"]')
            await web.tap(ACCOUNT)
            await web.see(NOTIFICATIONS)
            await ctx.checkpoint(checkpoint, {
              expect: [
                { text: 'Notifications' },
                { text: 'Ask Tess', absent: true }
              ],
              golden: {}
            })
          }
        },
        HEADER
      )
    },
    'absent-without-tess': async ctx => {
      await withTess(
        ctx,
        async web => {
          await web.open('/')
          await web.tap(MARK_MENU)
          expect(await web.page.$(ASK_TESS)).equals(null)
          await web.tap('[role="button"][aria-label="Close menu"]')
          await web.tap(ACCOUNT)
          await web.see(NOTIFICATIONS)
          await ctx.checkpoint('header-without-tess', {
            expect: [{ text: 'Notifications' }],
            golden: {}
          })
        },
        { ...HEADER, fixture: { tess: false } }
      )
    }
  }
})
