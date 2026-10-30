/** Reuses the task's one Maestro D browser and its signed-in synthetic fixture. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main(): Promise<void> {
  const {
    MAESTRO_D_CLIENT_ROOT,
    MAESTRO_D,
    MAESTRO_DEVICE,
    TS_CHAT_WEB,
    TS_CHAT_ORIGIN,
    TS_CHAT_ARTIFACTS
  } = process.env
  assert(MAESTRO_D_CLIENT_ROOT != null && MAESTRO_D_CLIENT_ROOT !== '')
  assert(MAESTRO_D != null && MAESTRO_D !== '')
  assert(MAESTRO_DEVICE != null && MAESTRO_DEVICE !== '')
  assert(TS_CHAT_WEB != null && TS_CHAT_WEB !== '')
  assert(TS_CHAT_ORIGIN != null && TS_CHAT_ORIGIN !== '')
  assert(TS_CHAT_ARTIFACTS != null && TS_CHAT_ARTIFACTS !== '')
  const { MaestroD } = require(
    resolve(MAESTRO_D_CLIENT_ROOT, 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({ name: MAESTRO_D, spawn: false })
  assert(
    (await daemon.status()).devices.some(
      (device: { id: string }) => device.id === MAESTRO_DEVICE
    ) === true
  )
  const m = await daemon.attach({ device: MAESTRO_DEVICE })
  const read = async (expression: string): Promise<any> =>
    JSON.parse(
      (
        await m.evalBrowserScript({
          script: `return JSON.stringify(${expression})`
        })
      ).data
    )
  const path = async (): Promise<string> =>
    await read('location.pathname+location.search')
  const at = async (expected: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if ((await path()) === expected) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(await path(), expected)
  }
  try {
    await m.openBrowser({ url: TS_CHAT_WEB + TS_CHAT_ORIGIN })
    await m.assertVisible({ id: 'entity-chat-list', timeout: 15000 })
    const row = await read(
      'document.querySelector(\'[data-testid^="entity-chat-cnv"]\').dataset.testid'
    )
    const selected = await read(
      'document.querySelector(\'[role="tab"][aria-label="Home"]\').innerHTML'
    )
    await m.tapOn({ css: `[data-testid="${row}"]` })
    const conversation = '/chat/' + row.slice('entity-chat-'.length)
    await at(conversation)
    await m.assertVisible({ id: 'chat-message-pane', timeout: 30000 })
    assert.equal(
      await read(
        'document.querySelector(\'[role="tab"][aria-label="Home"]\').innerHTML'
      ),
      selected
    )
    writeFileSync(
      resolve(TS_CHAT_ARTIFACTS, 'wide-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ css: '[aria-label="Back"]' })
    await at(TS_CHAT_ORIGIN)
    await m.assertVisible({ id: row, timeout: 10000 })
    await m.evalBrowserScript({ script: 'history.forward(); return true' })
    await at(conversation)
    await m.assertVisible({ id: 'chat-message-pane', timeout: 30000 })
    assert.equal(
      await read(
        'document.querySelector(\'[role="tab"][aria-label="Home"]\').innerHTML'
      ),
      selected
    )
    await m.evalBrowserScript({ script: 'history.back(); return true' })
    await at(TS_CHAT_ORIGIN)
    console.log(
      'PASS: same-tab full workspace, direct header Back, browser Back and Forward preserve the origin'
    )
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
