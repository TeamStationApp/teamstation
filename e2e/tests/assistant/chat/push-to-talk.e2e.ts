import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineHarness } from '../../../core/spec'
import {
  MIC,
  TESS_GOLDEN,
  TESS_WEB_SPEC,
  tessWebSurface,
  THINKING,
  withTess
} from '../../../rigs/tessWeb'

export default defineHarness({
  ...TESS_WEB_SPEC,
  // It covers the scoring screen's dictation controls, which draw in 3D.
  surfaces: tessWebSurface(['gpu']),
  id: 'assistant/chat/push-to-talk',
  title: 'What is said while her microphone is held becomes her next message',
  covers: [
    'src/app/tess/TessPanel.tsx',
    'src/app/scoring/dictationControls.tsx',
    'src/server/dictation/**'
  ],
  minutes: 1,
  faults: ['socket-drop', 'api-500'],
  scenarios: {
    'each-hold-becomes-a-message': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { HEARD } = await import('../../../../src/test/tessFixture')
          const { m, page, t } = web
          await web.open('/')
          await web.openChat()
          for (let time = 1; time <= 2; time++) {
            const heardBefore = await web.userBubbles(HEARD)
            const holding = m.longPressOn({ css: MIC, duration: 2500 })
            await web.waitForStatus('Recording', 2000)
            await page.evaluate(async () => {
              await (window as any).__playClip()
            })
            await holding
            await eventually(async () => {
              expect(await web.fieldValue()).equals(HEARD)
            }, 30000)
            expect(
              await web.userBubbles(HEARD),
              'a hold leaves the words in the field'
            ).equals(heardBefore)
            await m.pressKey({ key: 'Enter' })
            await eventually(async () => {
              expect(await web.userBubbles(HEARD)).greaterThan(heardBefore)
            }, 30000)
            await web.gone(THINKING)
          }
          expect(
            (await t.dictation()).heard.filter(heard => heard === HEARD)
          ).length(2)
          await ctx.checkpoint('two-messages-heard', {
            expect: [{ text: "Your team's settings are here" }],
            golden: TESS_GOLDEN
          })
        },
        { liveClock: true }
      )
    }
  }
})
