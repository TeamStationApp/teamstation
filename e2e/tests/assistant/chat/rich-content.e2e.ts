import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  FIELD,
  OPEN_FULL_SCREEN,
  OVERLAY,
  TESS_WEB_SPEC,
  VIEWER,
  VIEWER_CLOSE,
  withTess
} from '../../../rigs/tessWeb'

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/rich-content',
  title:
    'A chart opens over the pane with the chat still usable, and rich HTML loads nothing remote',
  covers: [
    'src/app/tess/RichBlock.tsx',
    'src/app/tess/RichFrame.tsx',
    'src/app/tess/RichViewer.tsx',
    'src/app/tess/richDocument.ts'
  ],
  minutes: 1,
  faults: ['layout-shift', 'missing-font'],
  scenarios: {
    'chart-over-the-pane-loads-nothing-remote': async ctx => {
      await withTess(ctx, async web => {
        const { m, t } = web
        await web.open('/')
        await web.openChat()
        await web.say('Chart our runs per game', "Demo Hawks' runs per game")
        await web.see('[data-testid="Tess rich block"]')
        await ctx.checkpoint('chart-card', {
          expect: [{ id: 'Tess rich block' }],
          golden: {}
        })
        await web.tap(OPEN_FULL_SCREEN)
        await web.see(VIEWER)
        expect(await web.rectOf(OVERLAY)).deep.equals(await web.paneRect())
        // The chat stays usable beside it.
        await m.tapOn({ css: FIELD })
        await web.type('still here')
        expect(await web.fieldValue()).equals('still here')
        await web.clearField()
        await ctx.checkpoint('chart-over-pane', {
          expect: [{ id: 'Tess rich viewer' }],
          golden: {}
        })
        await web.tap(VIEWER_CLOSE)
        await web.gone(VIEWER)
        await ctx.checkpoint('chart-closed', {
          readBack: async () => {
            expect(t.beaconHits(), 'a remote load').equals(0)
          }
        })
      })
    }
  }
})
