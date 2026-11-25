import assert from 'node:assert/strict'

import { isDevelopmentWebOrigin } from '../../../../src/common/primaryUrl'
import type { FixtureAccount } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'

const launcher = '/privacy.html#fixture-launcher'

function payload(account: FixtureAccount): string {
  return Buffer.from(account.email + '\n' + account.password, 'ascii').toString(
    'hex'
  )
}

// Runs in the fixture browser. Maestro operates the buttons by label so its
// navigation commands and action logs contain no generated passwords.
function installLauncher(origin: string, links: Record<string, string>): void {
  if (location.href !== origin + '/privacy.html#fixture-launcher') return
  document.addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('aside')
    Object.assign(controls.style, {
      position: 'fixed',
      zIndex: '99999',
      top: '0'
    })
    for (const [label, target] of Object.entries(links)) {
      const button = document.createElement('button')
      button.textContent = label
      button.onclick = () => {
        if (label === 'Embed link') {
          const frame = document.createElement('iframe')
          frame.src = target
          document.body.append(frame)
        } else location.assign(target)
      }
      controls.append(button)
    }
    document.body.prepend(controls)
  })
}

async function activeAccount(web: WebSession): Promise<string | null> {
  return await web.page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/me', { cache: 'no-store' })
    if (response.status === 401) return null
    if (!response.ok) throw Error('Failed to read session')
    return (await response.json()).id
  })
}

async function exercise(ctx: E2eContext): Promise<void> {
  const origin = ctx.stack.origin
  if (!isDevelopmentWebOrigin(origin)) {
    throw new BlockedError('Password links require a development web seat')
  }
  const { coach, player } = (await ctx.fixture('team-with-roster')).accounts
  const path = '/password-login#auth='
  const links = {
    'First account': path + payload(coach),
    'Second account': path + payload(player),
    'Wrong password': path + payload({ ...coach, password: 'invalid-fixture' }),
    'Malformed link': path + 'invalid',
    'Query only': '/password-login?auth=fixture-sentinel',
    'Embed link': path + payload(player)
  }
  const beforeLoad =
    '(' +
    installLauncher.toString() +
    ')(' +
    JSON.stringify(origin) +
    ',' +
    JSON.stringify(links) +
    ')'
  let requests = 0
  let leaked = false
  const markers = [
    payload(coach),
    payload(player),
    coach.password,
    player.password
  ]
  const browser = async () => {
    const web = await ctx.browser(
      { width: 1280, height: 800 },
      {
        beforeLoad,
        observeNetwork: true,
        h264: true
      }
    )
    web.page.on('request', request => {
      if (new URL(request.url()).pathname.endsWith('/auth/password/link'))
        requests++
      const wire = [
        request.url(),
        request.postData(),
        ...Object.values(request.headers())
      ]
      if (wire.some(value => markers.some(marker => value?.includes(marker))))
        leaked = true
    })
    return web
  }
  const open = async (web: WebSession, label: keyof typeof links) => {
    await web.m.openLink({ link: origin + launcher })
    await web.m.tapOn({ text: label })
  }
  const signedIn = async (web: WebSession, account: FixtureAccount) => {
    await web.page.waitForFunction(
      () => location.pathname === '/' && location.hash === ''
    )
    assert.equal(await activeAccount(web), account.userId)
  }
  const web = await browser()
  const framed = async (account: string | null) => {
    const before = requests
    await open(web, 'Embed link')
    await web.page.waitForFunction(
      () =>
        document.querySelector('iframe')?.contentWindow?.location.pathname ===
        '/sign-in'
    )
    assert.equal(requests, before)
    assert.equal(await activeAccount(web), account)
  }
  await framed(null)
  await open(web, 'Query only')
  await web.m.assertVisible({
    text: 'This sign-in link has an invalid auth value.'
  })
  assert.equal(web.page.url(), origin + '/sign-in')
  await open(web, 'Malformed link')
  await web.m.assertVisible({
    text: 'This sign-in link has an invalid auth value.'
  })
  assert.equal(web.page.url(), origin + '/sign-in')
  assert.equal(await activeAccount(web), null)
  await open(web, 'Wrong password')
  await web.m.assertVisible({ text: 'Sign-in failed.*' })
  assert.equal(await activeAccount(web), null)
  await open(web, 'First account')
  await signedIn(web, coach)
  await framed(coach.userId)
  await open(web, 'First account')
  await signedIn(web, coach)
  await open(web, 'Second account')
  await ctx.checkpoint('switch-prompt', {
    expect: [{ text: 'Switch account\\?' }]
  })
  assert.equal(web.page.url(), origin + '/sign-in')
  assert.equal(await activeAccount(web), coach.userId)
  await web.page.screenshot({ path: ctx.artifact('switch-after.png') })
  await web.m.tapOn({ text: 'Keep current account' })
  await signedIn(web, coach)
  await open(web, 'Second account')
  await web.m.assertVisible({ text: 'Keep current account' })
  await web.m.pressKey({ key: 'Tab' })
  await web.m.pressKey({ key: 'Enter' })
  await signedIn(web, player)
  const fresh = await browser()
  await open(fresh, 'First account')
  await signedIn(fresh, coach)
  assert.equal(
    leaked,
    false,
    'A fixture credential appeared in an outgoing request'
  )
}

export default defineE2e({
  id: 'account/sign-in/password-link',
  title: 'Development password links sign in and ask before switching accounts',
  kind: 'e2e',
  covers: [
    'src/app/web/index.tsx',
    'src/app/web/passwordLogin.ts',
    'src/server/routes/auth.ts'
  ],
  stack: 'seat',
  fixtures: ['team-with-roster'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  scenarios: { 'confirm-account-switch': exercise }
})
