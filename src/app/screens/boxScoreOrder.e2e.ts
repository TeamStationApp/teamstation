import assert from 'node:assert/strict'

import {
  attachWeb,
  connect,
  type Device,
  required,
  shot,
  signInWeb
} from '../../../e2e/rigs/replayKit'

/**
 * The Box score tab of the replay seed's final game lists the visitors'
 * pitchers in the order they took the mound: Cole, then Gil, who got more
 * outs. Run against a server and web build with the seed loaded:
 *
 *   REPLAY_GAME=gam_replaySeedFinal REPLAY_SHOT=box-score-pitchers-after \
 *   REPLAY_EXPECT=mound node -r sucrase/register src/app/screens/boxScoreOrder.e2e.ts
 *
 * `REPLAY_EXPECT=outs` checks a build from before, where the reliever with
 * more outs comes first, for the before screenshot.
 */
async function main(): Promise<void> {
  const daemon = await connect()
  let m: Device | undefined
  try {
    m = await attachWeb(daemon)
    await signInWeb(m, 'replay-team@example.test')
    await m.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${required('REPLAY_GAME')}?tab=boxScore`
    })
    await m.assertVisible({ text: 'Luis Gi', timeout: 20000 })
    // Each pitcher's last row on the page is their pitching line, which
    // follows the batting table. Bring the visitors' pitching table into view
    // and read its order.
    const order = await m.evalBrowserScript({
      script: `
        const rows = [...document.querySelectorAll('*')].filter(
          node => node.childElementCount === 0 &&
            ['Gerrit C', 'Luis Gi'].includes(node.textContent.trim())
        );
        const last = name => rows.filter(node => node.textContent.trim() === name).at(-1);
        const cole = last('Gerrit C'), gil = last('Luis Gi');
        if (!cole || !gil) throw new Error('No pitching rows');
        (cole.compareDocumentPosition(gil) & Node.DOCUMENT_POSITION_FOLLOWING ? cole : gil)
          .scrollIntoView({ block: 'center' });
        return cole.compareDocumentPosition(gil) & Node.DOCUMENT_POSITION_FOLLOWING
          ? 'mound' : 'outs';
      `
    })
    const result = JSON.stringify(order)
    const expected = process.env.REPLAY_EXPECT ?? 'mound'
    await new Promise(resolve => setTimeout(resolve, 500))
    await shot(m, required('REPLAY_SHOT'))
    assert.ok(
      result.includes(expected),
      `pitchers in ${result}, expected ${expected}`
    )
    console.log(`PASS: visitors' pitchers in ${expected} order`)
  } finally {
    await m?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
