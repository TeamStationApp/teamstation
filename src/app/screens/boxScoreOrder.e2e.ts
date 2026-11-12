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
    await m.assertVisible({ text: 'Gerrit C', timeout: 20000 })
    // Each pitcher's pitching line is the row with an IP cell, labelled
    // "<name>, IP, <innings>". Luis Gil and Luis Garcia both read `Luis G`
    // (develop 2971c5fd7: no letters are added to tell two names apart), and
    // only Gil pitches. Bring the visitors' pitching table into view and read
    // its order.
    const order = await m.evalBrowserScript({
      script: `
        const line = name => document.querySelector('[aria-label^="' + name + ', IP,"]');
        const cole = line('Gerrit C'), gil = line('Luis G');
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
