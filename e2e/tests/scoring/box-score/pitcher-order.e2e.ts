import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import { openEventWeb } from '../../../rigs/eventWeb'

/**
 * The Box score tab of the replay game, finished, lists the visitors'
 * pitchers in the order they took the mound: Cole, then Gil, who got more
 * outs.
 */

export default defineHarness({
  id: 'scoring/box-score/pitcher-order',
  title: "The box score lists a side's pitchers in the order they pitched",
  kind: 'e2e',
  covers: ['src/app/screens/BoxScore.tsx', 'src/app/screens/boxScoreTotals.ts'],
  stack: 'isolated',
  fixtures: ['replay-games'],
  exclusive: false,
  surfaces: {
    // The box score draws no 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'mound-order': async ctx => {
      const world = await ctx.fixture('replay-games')
      const web = await openEventWeb(ctx, world.accounts.team, {
        width: 402,
        height: 874
      })
      const { m } = web
      await web.go(`/games/${world.ids.finalGame}?tab=boxScore`)
      await m.assertVisible({ text: 'Luis G', timeout: 20000 })
      // Each pitcher's last row on the page is their pitching line, which
      // follows the batting table. Bring the visitors' pitching table into
      // view and read its order.
      const order = await web.evaluate<string>(`(() => {
        const rows = [...document.querySelectorAll('*')].filter(
          node => node.childElementCount === 0 &&
            ['Gerrit C', 'Luis G'].includes(node.textContent.trim())
        );
        const last = name => rows.filter(node => node.textContent.trim() === name).at(-1);
        const cole = last('Gerrit C'), gil = last('Luis G');
        if (!cole || !gil) return 'no pitching rows';
        const mound = cole.compareDocumentPosition(gil) & Node.DOCUMENT_POSITION_FOLLOWING;
        (mound ? cole : gil).scrollIntoView({ block: 'center' });
        return mound ? 'mound' : 'outs';
      })()`)
      await new Promise(resolve => setTimeout(resolve, 500))
      await web.shot('box-score-pitchers-after.png')
      expect(order, "the visitors' pitchers in mound order").to.equal('mound')
    }
  }
})
