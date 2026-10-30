/** Run against a signed-in, approved phone with the synthetic chat fixture. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  flatten,
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function main(): Promise<void> {
  const platform = required('CHAT117_PLATFORM')
  const artifacts = required('CHAT117_ARTIFACTS')
  mkdirSync(artifacts, { recursive: true })
  const daemon = await maestroClient().MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: process.env.MAESTRO_D_BIN,
    ...{ signal: AbortSignal.timeout(180000) }
  })
  const d = (await daemon.attach({
    device: required('CHAT117_DEVICE'),
    platform,
    appId:
      process.argv[2] === 'safari'
        ? 'com.apple.mobilesafari'
        : 'app.teamstation.app'
  })) as MaestroDevice & {
    setOrientation: (options: { orientation: string }) => Promise<unknown>
  }
  const tap = async (text: string): Promise<void> => {
    await d.tapOn({ text, timeout: 15000 })
  }
  const visible = async (text: string): Promise<void> => {
    await d.assertVisible({ text, timeout: 15000 })
  }
  const shot = async (name: string): Promise<void> => {
    writeFileSync(
      join(artifacts, `${platform}-${name}.png`),
      await d.screenshot()
    )
  }
  if (process.argv[2] === 'safari') {
    // Start in a conversation with the composer focused and keyboard open.
    const nodes = flatten(await d.hierarchy())
    const keyboard = nodes.find(n => n.type === 'Keyboard')?.bounds
    const composer = nodes.find(
      n => n.type === 'TextView' && n.id === 'Message'
    )?.bounds
    assert(keyboard != null && composer != null)
    assert(composer.y + composer.height <= keyboard.y)
    assert(!nodes.some(n => n.text === 'Home'))
    await shot('safari-keyboard')
    await tap('Done')
    await visible('Home')
    await d.setOrientation({ orientation: 'LANDSCAPE' })
    await visible('Home')
    await d.setOrientation({ orientation: 'PORTRAIT' })
    await visible('Home')
    console.log(
      'PASS Safari composer above keyboard, nav hidden then restored after dismissal and rotation',
      { composer, keyboard }
    )
    return
  }
  await d.hideKeyboard()
  for (let depth = 0; depth < 3; depth++) {
    if (!flatten(await d.hierarchy()).some(n => n.text === 'Back')) break
    await tap('Back')
  }
  await tap('Chat')
  await visible('New message')
  await visible('Spring 2027 - Harbor League.*')
  await shot('list')
  await tap('New message')
  await tap('Name')
  await d.inputText({ text: 'Lou' })
  await visible('Pick Lou G')
  await tap('Pick Lou G')
  await visible('Remove Lou G')
  // Typing without another focus tap proves the selected input retained focus.
  await d.inputText({ text: 'Willie' })
  await visible('Pick Willie M')
  await shot('people')
  console.log(
    `PASS ${platform} people selection clears and retains focus for the next search`
  )
  await tap('Back')
  await tap('Lou G.*')
  await visible('Lou G, Direct message')
  await tap('Lou G, Direct message')
  await visible('Safety words with Lou G, Member')
  await tap('Safety words with Lou G, Member')
  await visible('Compare these 16 words.*')
  const words = flatten(await d.hierarchy()).filter(n =>
    (n.id ?? '').startsWith('chat-safety-group-')
  )
  assert.equal(words.length, 16)
  assert.equal(new Set(words.map(n => Math.round(n.bounds?.x ?? -1))).size, 4)
  assert.equal(new Set(words.map(n => Math.round(n.bounds?.y ?? -1))).size, 4)
  await shot('safety')
  await tap('Done')
  await tap('Back')
  await d.tapOn({ id: 'chat-composer', timeout: 15000 })
  const message = `The ${platform} message is readable.`
  await d.inputText({ text: message })
  await visible('Send')
  const nodes = flatten(await d.hierarchy())
  const composer = nodes.find(n => n.id === 'chat-composer-band')?.bounds
  const keyboard = nodes.find(n => n.type === 'Keyboard')?.bounds
  if (platform === 'ios') {
    assert(composer != null && keyboard != null)
    assert(composer.y + composer.height <= keyboard.y)
  }
  await shot('keyboard')
  await tap('Send')
  await visible(message)
  console.log(
    `PASS ${platform} sixteen safety words in 4x4 and encrypted message send`,
    { composer, keyboard }
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
