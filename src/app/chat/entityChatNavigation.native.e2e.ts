/** Run on the explicitly delegated physical phone, already signed into a synthetic account. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main(): Promise<void> {
  const {
    MAESTRO_D_CLIENT_ROOT,
    MAESTRO_D,
    MAESTRO_DEVICE,
    TS_CHAT_APP_ID,
    TS_CHAT_ENTITY_LABEL,
    TS_CHAT_GROUP_LABEL,
    TS_CHAT_ARTIFACTS
  } = process.env
  assert(MAESTRO_D_CLIENT_ROOT != null && MAESTRO_D_CLIENT_ROOT !== '')
  assert(MAESTRO_D != null && MAESTRO_D !== '')
  assert(MAESTRO_DEVICE != null && MAESTRO_DEVICE !== '')
  assert(TS_CHAT_APP_ID != null && TS_CHAT_APP_ID !== '')
  assert(TS_CHAT_ENTITY_LABEL != null && TS_CHAT_ENTITY_LABEL !== '')
  assert(TS_CHAT_GROUP_LABEL != null && TS_CHAT_GROUP_LABEL !== '')
  assert(TS_CHAT_ARTIFACTS != null && TS_CHAT_ARTIFACTS !== '')
  const { MaestroD } = require(
    resolve(MAESTRO_D_CLIENT_ROOT, 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({ name: MAESTRO_D, spawn: false })
  const m = await daemon.attach({ device: MAESTRO_DEVICE })
  try {
    await m.launchApp({ appId: TS_CHAT_APP_ID })
    await m.tapOn({ text: '^Home$', timeout: 30000 })
    await m.tapOn({ text: '^Home$' })
    if (process.env.TS_CHAT_FROM_SEARCH === '1') {
      await m.tapOn({ text: '^Search$' })
      await m.tapOn({ text: '^Leagues$' })
    }
    await m.tapOn({ text: TS_CHAT_ENTITY_LABEL })
    await m.tapOn({ text: '^Chats$' })
    await m.assertVisible({ id: 'entity-chat-list', timeout: 15000 })
    await m.tapOn({ text: TS_CHAT_GROUP_LABEL })
    await m.assertVisible({ text: '^Message$', timeout: 30000 })
    writeFileSync(
      resolve(TS_CHAT_ARTIFACTS, 'narrow-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: '^Back$' })
    await m.assertVisible({ id: 'entity-chat-list', timeout: 15000 })
    await m.assertVisible({ text: TS_CHAT_GROUP_LABEL })
    await m.tapOn({ text: TS_CHAT_GROUP_LABEL })
    await m.assertVisible({ text: '^Message$', timeout: 15000 })
    await m.back()
    await m.assertVisible({ id: 'entity-chat-list', timeout: 15000 })
    await m.assertVisible({ text: TS_CHAT_GROUP_LABEL })
    writeFileSync(
      resolve(TS_CHAT_ARTIFACTS, 'pixel-after.png'),
      await m.screenshot()
    )
    console.log(
      'PASS: native header Back and Android system Back return directly to the originating entity Chats section'
    )
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
