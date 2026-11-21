import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import { TESS_GOLDEN, TESS_WEB_SPEC, withTess } from '../../../rigs/tessWeb'

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/refusals',
  title:
    'Tess declines what is off topic with no tool, and a scoring write is refused before any card',
  covers: ['src/server/tess/denyList.ts', 'src/server/tess/tools.ts'],
  minutes: 1,
  faults: ['wrong-data', 'api-garbage'],
  scenarios: {
    'off-topic-declined-with-no-tool': async ctx => {
      await withTess(ctx, async web => {
        const { t } = web
        await web.open('/')
        await web.openChat()
        await web.say(
          'Write me a poem about cats',
          'I can only help with finding'
        )
        const poem = t.model.calls.filter(call =>
          (call.request?.said ?? '').includes('poem about cats')
        )
        expect(poem).length(1)
        expect(poem[0].stopReason).equals('end_turn')
        await ctx.checkpoint('declined', {
          expect: [
            { text: 'I can only help with finding' },
            { text: 'Demo League A' }
          ],
          golden: TESS_GOLDEN
        })
      })
    },
    'scoring-write-refused-before-any-card': async ctx => {
      await withTess(ctx, async web => {
        const { t } = web
        await web.open('/')
        await web.openChat()
        await web.say('Record a strike for the batter', 'I cannot record plays')
        const strike = t.model.calls.filter(call =>
          (call.request?.said ?? '').includes('Record a strike')
        )
        const refusal = strike
          .flatMap(call => call.request?.messages.slice(-1) ?? [])
          .flatMap(message =>
            Array.isArray(message.content) ? message.content : []
          )
          .find(block => block.type === 'tool_result')
        expect(refusal, 'the tool result').not.equals(undefined)
        expect(refusal!.is_error).equals(true)
        expect(String(refusal!.content)).includes('may not change live scoring')
        await ctx.checkpoint('refused', {
          expect: [
            { text: 'I cannot record plays' },
            { id: 'Tess change', absent: true }
          ],
          golden: TESS_GOLDEN
        })
      })
    }
  }
})
