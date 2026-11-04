/** Legacy API actions whose controls are absent from the current message menu. */
import { ChatEngine } from '../app/chat/engine/engine'
import { keyStore } from '../app/chat/keyStore'
import { TeamStationClient } from '../common/api'
import { loadChatCore } from '../common/chatCrypto/core.web'

export async function retainedBrowserAction(input: {
  apiUrl: string
  userId: string
  conversationId: string
  messageId: string
  action: 'edit' | 'report'
  body?: string
  wasmUrl: string
  wasmIntegrity: string
}): Promise<void> {
  const url = new URL(input.apiUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  )
    throw new Error('Legacy action fixture requires the owned local API')
  const client = new TeamStationClient({ baseUrl: input.apiUrl })
  const user = await client.whoAmI()
  if (
    user?.id !== input.userId ||
    user.email?.endsWith('@chat.example.com') !== true
  )
    throw new Error(
      'Legacy action requires its signed-in synthetic participant'
    )
  if (!(await keyStore.exists()))
    throw new Error('Retained browser keys required')
  if (
    !(
      await loadChatCore({ url: input.wasmUrl, integrity: input.wasmIntegrity })
    ).ready
  )
    throw new Error('The application crypto module must pass its self-test')
  const before = await keyStore.load()
  if (before?.userId !== user.id || before.identity == null)
    throw new Error(
      'The browser identity must already belong to the participant'
    )
  const engine = new ChatEngine({
    client,
    store: keyStore,
    userId: user.id,
    device: { name: 'Synthetic retained browser', platform: 'web' }
  })
  try {
    if ((await engine.start(true)) !== 'ready')
      throw new Error('Existing enrollment required')
    await engine.open(input.conversationId)
    if (input.action === 'edit') {
      if (input.body == null) throw new Error('Edit body required')
      await engine.edit(input.conversationId, input.messageId, input.body)
    } else if (input.action === 'report') {
      const report = await engine.report(input.conversationId, input.messageId)
      if (!report.verified) throw new Error('Report signature was not verified')
    } else throw new Error('Unsupported legacy action')
    const after = await keyStore.load()
    if (
      after?.identity?.id !== before.identity.id ||
      after.deviceId !== before.deviceId
    )
      throw new Error('Legacy action changed the retained enrollment')
  } finally {
    engine.stop()
    await engine.idle()
  }
}
