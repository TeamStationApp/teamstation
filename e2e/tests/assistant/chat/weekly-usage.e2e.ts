import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import { TESS_WEB_SPEC, withTess } from '../../../rigs/tessWeb'

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/weekly-usage',
  title: "The week's usage adds up to what the model really answered",
  covers: ['src/server/tess/usage.ts', 'src/server/routes/tess.ts'],
  minutes: 1,
  faults: ['api-500'],
  scenarios: {
    'week-adds-up-to-the-model-calls': async ctx => {
      await withTess(ctx, async web => {
        const { t } = web
        await web.open('/')
        await web.openChat()
        await web.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await web.say(
          'Write me a poem about cats',
          'I can only help with finding'
        )
        await ctx.checkpoint('usage-after-two-messages', {
          expect: [{ text: 'I can only help with finding' }],
          readBack: async () => {
            const usage = await t.f.h.request('GET', '/me/tess/usage')
            expect(usage.status).equals(200)
            const { weeks } = (await usage.json()) as {
              weeks: Array<{
                inputTokens: number
                outputTokens: number
                requests: number
              }>
            }
            const totals = t.model.totals()
            expect(totals.requests).greaterThan(0)
            expect(weeks).length(1)
            expect(weeks[0]).deep.include({
              inputTokens: totals.input,
              outputTokens: totals.output,
              requests: totals.requests
            })
          }
        })
      })
    }
  }
})
