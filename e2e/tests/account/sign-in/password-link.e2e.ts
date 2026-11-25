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
        if (label === 'Arm first link') {
          const channel = new BroadcastChannel('password-link-fixture')
          channel.onmessage = () => {
            channel.close()
            location.assign(target)
          }
          button.textContent = 'First link ready'
        } else if (label === 'Release both links') {
          const channel = new BroadcastChannel('password-link-fixture')
          channel.postMessage('open')
          channel.close()
          location.assign(target)
        } else if (label === 'Embed link') {
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
  if (
    !isDevelopmentWebOrigin(origin, process.env.TS_WEB_PASSWORD_LINK_ORIGIN)
  ) {
    throw new BlockedError('Password links require a development web seat')
  }
  const { coach, player } = (await ctx.fixture('team-with-roster')).accounts
  const path = '/password-login#auth='
  const queryMarker = 'fixture-query-sentinel'
  const links = {
    'Arm first link': path + payload(coach),
    'Release both links': path + payload(player),
    'First account': path + payload(coach),
    'Second account': path + payload(player),
    'Wrong password': path + payload({ ...coach, password: 'invalid-fixture' }),
    'Malformed link': path + 'invalid',
    'Query only': '/password-login?auth=' + queryMarker,
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
    queryMarker,
    payload(coach),
    payload(player),
    coach.password,
    player.password
  ]
  const browser = async (): Promise<WebSession> => {
    const web = await ctx.browser(
      { width: 1280, height: 800 },
      {
        beforeLoad,
        observeNetwork: true
      }
    )
    // Puppeteer appends CDP's browser-only urlFragment to request.url().
    // Inspect the network URL and headers exactly as Chrome reports them.
    const network = await web.page.createCDPSession()
    await network.send('Network.enable')
    network.on('Network.requestWillBeSent', ({ request, type }) => {
      if (new URL(request.url).pathname.endsWith('/auth/password/link'))
        requests++
      // A query is necessarily sent on its initial document request. Every
      // subsequent resource URL, header and body must keep the marker private.
      const initialQuery =
        type === 'Document' && request.url === origin + links['Query only']
      const wire = [
        initialQuery ? '' : request.url,
        ...(request.postDataEntries ?? []).map(entry =>
          Buffer.from(entry.bytes ?? '', 'base64').toString()
        ),
        ...Object.values(request.headers)
      ]
      if (wire.some(value => markers.some(marker => value.includes(marker))))
        leaked = true
    })
    return web
  }
  const open = async (
    web: WebSession,
    label: keyof typeof links
  ): Promise<void> => {
    await web.m.openLink({ link: origin + launcher })
    await web.m.tapOn({ text: label })
  }
  const signedIn = async (
    web: WebSession,
    account: FixtureAccount
  ): Promise<void> => {
    await web.page.waitForFunction(
      () => location.pathname === '/' && location.hash === ''
    )
    assert.equal(await activeAccount(web), account.userId)
  }
  const web = await browser()
  const framed = async (account: string | null): Promise<void> => {
    const before = requests
    await open(web, 'Embed link')
    const child = await web.page.waitForFrame(
      frame =>
        frame.parentFrame() !== null &&
        (frame.url() === origin + '/sign-in' ||
          frame.url() === 'chrome-error://chromewebdata/')
    )
    if (child.url() !== origin + '/sign-in') {
      const denied = await web.page.evaluate(async () => {
        const { headers } = await fetch('/password-login', { method: 'HEAD' })
        const framePolicy = headers.get('x-frame-options')
        const contentPolicy = headers.get('content-security-policy')
        return (
          (framePolicy !== null && framePolicy.toUpperCase() === 'DENY') ||
          (contentPolicy !== null &&
            /(?:^|;)\s*frame-ancestors\s+'none'(?:\s*;|$)/i.test(contentPolicy))
        )
      })
      assert.ok(denied, 'Expected the seat to deny framing this document')
    }
    assert.equal(requests, before)
    assert.equal(await activeAccount(web), account)
  }
  // Visit with a cold font cache so later resource requests are observable.
  await open(web, 'Query only')
  await web.m.assertVisible({
    text: 'This sign-in link has an invalid auth value.'
  })
  assert.equal(web.page.url(), origin + '/sign-in')
  await framed(null)
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
  await web.m.assertVisible({ text: 'Keep current account', timeout: 30000 })
  await ctx.checkpoint('switch-prompt', {
    expect: [{ text: 'Keep current account' }, { text: 'Switch account' }]
  })
  assert.equal(web.page.url(), origin + '/sign-in')
  assert.equal(await activeAccount(web), coach.userId)
  assert.equal(
    await web.page.$eval('main h1', h => h.textContent),
    'Switch account?'
  )
  await web.page.screenshot({ path: ctx.artifact('switch-after.png') })
  await web.m.tapOn({ text: 'Keep current account' })
  await signedIn(web, coach)
  await open(web, 'Second account')
  await web.m.assertVisible({ text: 'Keep current account' })
  const sibling = await web.openTab('account')
  {
    await web.m.openLink({ link: origin })
    const showsAccount = async (name: string): Promise<void> => {
      await sibling.waitForFunction(
        (label: string) => {
          // Puppeteer serializes this callback without transpiler helpers.
          const footer = document.querySelector<HTMLElement>(
            '[data-testid="sidebar-account-footer"]'
          )
          if (footer === null) return false
          return footer.innerText.includes(label)
        },
        { polling: 100 },
        name
      )
    }
    await showsAccount(coach.displayName)
    await web.m.switchTab({ url: origin + '/sign-in' })
    await web.m.pressKey({ key: 'Tab' })
    await web.m.pressKey({ key: 'Enter' })
    await signedIn(web, player)
    await web.m.switchTab({ tabLabel: 'account' })
    await showsAccount(player.displayName)
  }
  const fresh = await browser()
  // Both tabs begin without a cookie in this new context. Whichever link
  // goes second must ask before it can take over the shared session.
  await open(fresh, 'Arm first link')
  await fresh.m.assertVisible({ text: 'First link ready' })
  const other = await fresh.openTab('challenger')
  {
    const pages = [fresh.page, other]
    await open(fresh, 'Release both links')
    const states = await Promise.all(
      pages.map(async tab => {
        await tab.waitForFunction(
          () =>
            location.pathname === '/' ||
            document.querySelector('main button') !== null,
          { polling: 100 }
        )
        return new URL(tab.url()).pathname
      })
    )
    assert.deepEqual([...states].sort(), ['/', '/sign-in'])
    const winner = states[0] === '/' ? coach : player
    assert.equal(await activeAccount(fresh), winner.userId)
  }
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
