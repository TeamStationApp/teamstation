/**
 * The declared-age gate on a signed-out capsule and on the chat fixture pages.
 *
 * iOS, one simulator, Maestro D already up as `appleDeclaredAge`:
 *
 *   MAESTRO_D=appleDeclaredAge MAESTRO_DEVICE=<simulator udid> \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *   TS_CHAT_ARTIFACTS=<artifacts> \
 *     node -r sucrase/register src/app/chat/declaredAge.e2e.ts ios
 *
 * Web, one Chromium already attached, against a serve whose
 * `TS_DECLARED_AGE_LOWER` is unset, `12`, or `13`:
 *
 *   TS_DECLARED_AGE_LOWER=12|13|<unset> TS_CHAT_WEB=http://127.0.0.1:8080 \
 *   TS_CHAT_FIXTURE=<fixture.json> TS_CHAT_ARTIFACTS=<artifacts> \
 *   MAESTRO_D=appleDeclaredAge MAESTRO_DEVICE=<browser id> \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *     node -r sucrase/register src/app/chat/declaredAge.e2e.ts web
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function ios(): Promise<void> {
  const artifacts = required('TS_CHAT_ARTIFACTS')
  const { MaestroD } = require(
    resolve(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const m = await daemon.attach({ device: required('MAESTRO_DEVICE') })
  const nav = async (): Promise<void> => {
    for (const label of ['Home', 'Videos', 'Schedule', 'Search']) {
      console.log(`$ assertVisible ${label}`)
      await m.assertVisible({ text: label, timeout: 20000 })
    }
  }
  const shot = async (name: string): Promise<void> => {
    writeFileSync(resolve(artifacts, name), await m.screenshot())
    console.log(`$ screenshot ${resolve(artifacts, name)}`)
  }
  try {
    console.log('$ launchApp TS_DECLARED_AGE_LOWER=12')
    await m.launchApp({
      appId: 'app.teamstation.app',
      environment: { TS_DECLARED_AGE_LOWER: '12' }
    })
    await nav()
    console.log('$ assertNotVisible Chat')
    await m.assertNotVisible({ text: 'Chat', timeout: 20000 })
    await shot('nav-denied-after.png')
    await m.stopApp({ appId: 'app.teamstation.app' })
    console.log('$ launchApp TS_DECLARED_AGE_LOWER=13')
    await m.launchApp({
      appId: 'app.teamstation.app',
      environment: { TS_DECLARED_AGE_LOWER: '13' }
    })
    await nav()
    console.log('$ assertVisible Chat')
    await m.assertVisible({ text: 'Chat', timeout: 20000 })
    await shot('nav-allowed-after.png')
  } finally {
    await m.detach?.()
  }
}

async function web(): Promise<void> {
  const artifacts = required('TS_CHAT_ARTIFACTS')
  const webUrl = required('TS_CHAT_WEB').replace(/\/$/, '')
  const fixture = JSON.parse(readFileSync(required('TS_CHAT_FIXTURE'), 'utf8'))
  const phase =
    process.env.TS_DECLARED_AGE_LOWER === '12' ? 'denied' : 'allowed'
  const { MaestroD } = require(
    resolve(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const status = await daemon.status()
  assert(
    status.devices.some(
      (device: { id: string }) => device.id === required('MAESTRO_DEVICE')
    ) === true,
    'Reuse the existing browser; never launch another'
  )
  const m = await daemon.attach({ device: required('MAESTRO_DEVICE') })
  const shot = async (name: string): Promise<void> => {
    writeFileSync(resolve(artifacts, name), await m.screenshot())
    console.log(`$ screenshot ${resolve(artifacts, name)}`)
  }
  const playerId = fixture.people?.P?.userId
  assert(fixture.leagueId != null, 'the chat seed has a league')
  assert(playerId != null, 'the chat seed has player P')
  assert(fixture.conversationId != null, 'the fixture names one conversation')
  const pages: Array<[string, string, string]> = [
    ['team', `/teams/${fixture.teams.hawks}?tab=chats`, 'Team sections'],
    [
      'season',
      `/groups/season/${fixture.seasonId}?tab=chats`,
      'Season sections'
    ],
    ['league', `/groups/league/${fixture.leagueId}?tab=chats`, 'Seasons'],
    ['player', `/players/${playerId}`, 'Videos'],
    ['bubbles', `/chat/${fixture.conversationId}`, 'Message']
  ]
  try {
    for (const [name, path, landmark] of pages) {
      console.log(`$ open ${webUrl}${path}`)
      await m.openBrowser({ url: webUrl + path })
      // A denied conversation address is Home, so the composer landmark is gone.
      const landmarkText =
        phase === 'denied' && name === 'bubbles' ? 'Your Home' : landmark
      await m.assertVisible({ text: landmarkText, timeout: 20000 })
      if (phase === 'denied') {
        await m.assertNotVisible({ text: 'Chats', timeout: 5000 })
        if (name === 'bubbles')
          await m.assertNotVisible({ id: 'chat-composer', timeout: 5000 })
        if (name === 'player')
          await m.assertNotVisible({ id: 'person-message', timeout: 5000 })
        await shot(`${name}-denied-after.png`)
      } else {
        if (name === 'bubbles')
          await m.assertVisible({ id: 'chat-composer', timeout: 20000 })
        if (name === 'player')
          await m.assertVisible({ id: 'person-message', timeout: 20000 })
        if (name === 'team' || name === 'season' || name === 'league')
          await m.assertVisible({ text: 'Chats', timeout: 20000 })
        const suffix =
          process.env.TS_DECLARED_AGE_LOWER === '13' ? 'allowed' : 'before'
        await shot(
          suffix === 'before'
            ? `${name}-before.png`
            : `${name}-allowed-after.png`
        )
      }
    }
  } finally {
    await m.detach?.()
  }
}

const mode = process.argv[2]
if (mode === 'ios')
  ios().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
else if (mode === 'web')
  web().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
else {
  console.error('usage: declaredAge.e2e.ts ios|web')
  process.exit(2)
}
