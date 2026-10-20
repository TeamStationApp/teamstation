import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from 'chai'

import { userIdOfGumbo } from '../../common/userId'
import { guardianFixture } from '../../test/guardianFixture'
import {
  browserSession,
  capture,
  contains,
  maestro
} from '../../test/refinementsMaestro.e2e'

/** Real public thumbnails and membership approval, driven on a mobile browser. */
async function main(): Promise<void> {
  const out = process.env.TS_ARTIFACTS_DIR
  if (out == null) throw new Error('Supply TS_ARTIFACTS_DIR')
  await mkdir(out, { recursive: true })
  const f = await guardianFixture(resolve('dist'))
  const d = await maestro('video-membership')
  const s = await browserSession(
    d,
    'video-membership-web',
    390,
    844,
    out,
    'chrome'
  )
  const game = f.games[0]
  const gamePath = `/games/${game.id}?tab=watch`
  const playbackCalls: string[] = []
  s.page.on('request', request => {
    if (request.url().includes('/playback')) playbackCalls.push(request.url())
  })
  const open = async (): Promise<void> => {
    await s.m.openBrowser({ url: f.h.origin + gamePath })
    await s.page.waitForSelector('[data-testid="gameVideoPreview"]')
    await s.page.waitForSelector('[aria-label^="Play highlight:"]')
    await s.page.waitForFunction(() => {
      const imgs = [
        ...document.querySelectorAll<HTMLImageElement>(
          '[data-testid="gameVideoPreview"] img, [aria-label^="Play highlight:"] img'
        )
      ]
      return (
        imgs.length > 1 &&
        imgs.every(img => img.complete && img.naturalWidth > 0)
      )
    })
    expect(await s.page.$('video')).equals(null)
    expect(await s.page.$('[data-testid="warningSheet"]')).equals(null)
  }
  try {
    // This profile is test-owned; start without the cookie from a previous run.
    await s.browser.setCookie({
      name: 'ts_session',
      value: '',
      expires: 1,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    await open()
    await capture(s.m, out, 'guest-thumbnails.png')
    await s.m.tapOn({ css: '[data-testid="gameVideoPreview"]' })
    await contains(s.page, 'Log in or create an account first')
    await capture(s.m, out, 'guest-warning.png')
    await s.m.tapOn({ text: 'Log in / Sign up', role: 'button' })
    await s.page.waitForFunction(() => location.pathname === '/sign-in')
    expect(new URL(s.page.url()).searchParams.get('next')).equals(gamePath)
    expect(await s.page.$('input')).not.equals(null)
    await open()
    await s.m.tapOn({ css: '[aria-label^="Play highlight:"]', index: 0 })
    await contains(s.page, 'Log in / Sign up')
    await s.m.tapOn({ text: 'Close warning', role: 'button', index: 1 })
    expect(playbackCalls).deep.equals([])

    const user = f.people.follower
    await s.browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(user)!,
      domain: new URL(f.h.origin).hostname,
      path: '/',
      httpOnly: true
    })
    await open()
    await s.m.tapOn({ css: '[aria-label^="Play highlight:"]', index: 0 })
    await contains(s.page, 'Request membership')
    await capture(s.m, out, 'nonmember-warning.png')
    await s.m.tapOn({ text: 'Request membership', role: 'button' })
    await s.page.waitForSelector('[role="radio"]')
    const team = await f.h.db
      .selectFrom('teams')
      .select('name')
      .where('id', '=', f.teamA)
      .executeTakeFirstOrThrow()
    await s.m.tapOn({ text: team.name, role: 'radio' })
    await s.m.tapOn({ text: 'Send request', role: 'button' })
    await contains(s.page, 'Membership request sent')
    await capture(s.m, out, 'membership-request-sent.png')
    expect(playbackCalls).deep.equals([])
    const pending = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('kind', '=', 'membership')
      .where('sender_id', '=', userIdOfGumbo(user))
      .executeTakeFirstOrThrow()
    expect(pending.status).equals('pending')
    const stillLocked = await f.h.request(
      'GET',
      `/videos/${game.videoId}/playback`,
      undefined,
      user
    )
    expect(stillLocked.status).equals(403)
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${pending.id}/accept`,
      {},
      f.people.admin
    )
    expect(accepted.status, await accepted.clone().text()).equals(200)
    const unlocked = await f.h.request(
      'GET',
      `/videos/${game.videoId}/playback`,
      undefined,
      user
    )
    expect(unlocked.status).equals(200)
    console.log(
      'Guest and nonmember posters, highlight taps, login routing, membership request and approval verified.'
    )
  } finally {
    await s.browser.disconnect()
    await s.m.detach()
    await d.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
