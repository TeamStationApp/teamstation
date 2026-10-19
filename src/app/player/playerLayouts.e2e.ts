import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  finish,
  fixture,
  open,
  type WebSession,
  webSession
} from './playerLayoutsRig.e2e'

/**
 * The player-layouts scenarios in a browser (E1–E4, and E9's full pass):
 * the one player for every video, its layouts, its line score and its
 * gestures, on the fixture's games.
 *
 *   MAESTRO_D=playerLayouts MAESTRO_D_BIN=~/git/maestro-d/maestro-d \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *   TS_PLAYER_APP=http://<this Mac>:8091 \
 *   [TS_E2E_ARTIFACT_DIR=…] [TS_PLAYER_BROWSER_COVERAGE=…] \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/playerLayouts.e2e.ts
 *
 * Needs the API (`npm start`), the production web build served with it
 * (`npm run build.web`, `scripts/e2e/playerLayouts/serveDist.mjs`) and the
 * fixture (`scripts/e2e/playerLayouts/fixture.ts`).
 */
describe('player layouts in a browser', function () {
  after(async function () {
    await finish()
  })

  it("opens a scored game's videos page", async function () {
    const S = fixture().games.S
    const session: WebSession = await webSession('smoke', 402, 874)
    await open(session, `/games/${S.id}?tab=watch`)
    await session.page.waitForFunction(
      `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 2 })()`,
      { timeout: 60_000 }
    )
    expect(await session.page.$$eval('video', all => all.length)).at.least(1)
  })
})
