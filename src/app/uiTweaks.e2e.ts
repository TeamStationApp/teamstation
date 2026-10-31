import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { build } from 'esbuild'

import {
  browserSession,
  capture,
  contains,
  fill,
  maestro
} from '../../e2e/rigs/refinementsMaestro'
import { verifyMediaPath } from '../server/media/mediaTokens'
import { mediaRoutes } from '../server/routes/media'
import { groupFixture } from '../test/groupFixtures'
import { seedSettingsCleanup3 } from '../test/settingsCleanup3Fixture'

async function main(): Promise<void> {
  const out = resolve(process.env.TS_ARTIFACTS_DIR ?? 'artifacts/uiTweaks')
  const before = process.env.TS_UI_BEFORE === '1'
  const suffix = before ? 'before' : 'after'
  if (!before) {
    const { webSettings } = await import(
      resolve('scripts/web-build-settings.mjs')
    )
    await build({
      ...webSettings,
      entryPoints: ['src/test/gameHeroActions.fixture.tsx'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      outfile: 'dist/game-actions-fixture.js',
      define: {
        __DEV__: 'true',
        global: 'globalThis',
        'process.env': '{}',
        'process.env.NODE_ENV': '"development"'
      },
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
    })
    const font = (await readdir('dist/fonts')).find(name =>
      name.startsWith('SpaceGrotesk-SemiBold')
    )!
    await writeFile(
      'dist/game-actions-fixture.html',
      `<meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:'Space Grotesk';font-weight:600;src:url('/fonts/${font}')}html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/game-actions-fixture.js"></script>`
    )
  }
  const mediaRoot = join(out, 'support', 'media')
  const videoDir = join(mediaRoot, 'work/videos/vid_ui_tweaks')
  await mkdir(videoDir, { recursive: true })
  execFileSync(process.env.TS_FFMPEG ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24',
    '-t',
    '90',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    join(videoDir, 'master.m3u8')
  ])
  const f = await groupFixture(
    resolve(process.env.TS_UI_WEB_ROOT ?? 'dist'),
    undefined,
    (app, { db, media }) => {
      media.mediaRoot = mediaRoot
      app.use('/api/v1', mediaRoutes(db, media))
      app.get('/media/{*path}', (req, res) => {
        const verified = verifyMediaPath(media.mediaSecret, req.path)
        if (!verified.ok) {
          res.sendStatus(403)
          return
        }
        res.sendFile(join(mediaRoot, verified.media.dir, verified.media.rest), {
          dotfiles: 'allow'
        })
      })
    },
    {
      autocomplete: async query =>
        query.toLowerCase().includes('springfield')
          ? [
              {
                id: 'google:springfield-il',
                primary: 'Springfield',
                secondary: 'Illinois, United States'
              }
            ]
          : [],
      locality: async () => ({
        city: 'Springfield',
        region: 'Illinois',
        country: 'United States',
        timezone: 'America/Chicago',
        placeId: 'springfield-il'
      }),
      eventPlaces: async () => [],
      coordinates: async () => ({ latitude: 39.8, longitude: -89.6 }),
      venueDetails: async () => {
        throw new Error('This suite looks up no venue')
      }
    }
  )
  const d = await maestro(process.env.MAESTRO_D ?? `ui-tweaks-${suffix}`)
  const s = await browserSession(
    d,
    process.env.TS_UI_DEVICE ?? `ui-tweaks-${suffix}-web`,
    390,
    844,
    out,
    'chrome'
  ).catch(async (error: unknown) => {
    await d.shutdown()
    await f.h.close()
    throw error
  })
  const logs = ['$ node -r sucrase/register src/app/uiTweaks.e2e.ts']
  const open = async (path: string, expected: string): Promise<void> => {
    console.log('Open', path)
    await s.m.openBrowser({ url: f.h.origin + path })
    await contains(s.page, expected)
  }
  const shot = async (name: string): Promise<void> => {
    await capture(s.m, out, `${name}-${suffix}.png`)
  }
  const identity = async (id: number | null): Promise<void> => {
    await s.browser.setCookie({
      name: 'ts_session',
      value: '',
      expires: 1,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    if (id != null)
      await s.browser.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(id)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true
      })
  }
  s.page.on('pageerror', error => {
    console.error(
      'Browser error:',
      error instanceof Error ? error.message : String(error)
    )
  })
  try {
    await seedSettingsCleanup3(f)
    await f.h.db
      .updateTable('games')
      .set({
        notes: 'Private team notes',
        linescore: {
          away: { runs: [1, 1], r: 2, h: 5, e: 1 },
          home: { runs: [3, 1], r: 4, h: 7, e: 0 }
        }
      })
      .where('id', '=', 'gam_settings3_final')
      .execute()
    await f.h.db
      .insertInto('videos')
      .values({
        id: 'vid_ui_tweaks',
        game_id: 'gam_settings3_final',
        title: 'Demo recording',
        kind: 'program',
        status: 'ready',
        storage: 'local',
        duration_sec: 90
      })
      .execute()
    if (!before)
      for (const id of [null, 103]) {
        console.log(
          'Public access identity',
          id == null ? 'anonymous' : 'nonmember'
        )
        await identity(id)
        await open(`/teams/${f.teamA}?tab=videos`, 'GAME VIDEO LIBRARY')
        expect(await s.page.$('[data-testid="teamTabContent"]')).not.equals(
          undefined
        )
        if (id == null) await shot('public-videos')
        await s.m.tapOn({
          css: '[role="button"][aria-label*="Orchard Owls"]',
          timeout: 10000
        })
        await s.page.waitForSelector('[data-testid="gameVideoPreview"]')
        await s.m.tapOn({ css: '[data-testid="gameVideoPreview"]' })
        await contains(
          s.page,
          "You need to be a member of one of the teams to watch this game's videos."
        )
        expect(await s.page.$('video[src]')).equals(null)
        if (id == null) await shot('public-video-warning')
        await s.m.tapOn({ text: 'Close warning', role: 'button', index: 1 })
        await open(`/teams/${f.teamA}?tab=schedule`, 'Schedule')
        await s.m.tapOn({
          css: '[data-testid="schedule-display-row"]',
          index: 0,
          timeout: 10000
        })
        await s.page.waitForFunction(() =>
          location.pathname.includes('/games/')
        )
        await open(
          '/games/gam_settings3_final?tab=boxScore',
          'individual player stats'
        )
        expect(
          await s.page.evaluate(() => document.body.innerText)
        ).not.includes('Private team notes')
        if (id == null) await shot('public-game')
        await open(`/teams/${f.teamA}?tab=team`, 'ADMINS')
        await contains(s.page, 'Babe R')
        await contains(s.page, 'League admin')
        expect(
          await s.page.evaluate(() => {
            const sections = document.querySelectorAll(
              '[data-testid="public-staff"], [data-testid="teamTabContent"]'
            )
            return (
              sections.length > 0 &&
              [...sections].every(
                section =>
                  section.querySelector(
                    '[role="button"], a, [tabindex="0"]'
                  ) === null
              )
            )
          })
        ).equals(true)
        const staffAddress = s.page.url()
        await s.m.tapOn({ text: 'Babe R' })
        await s.m.pressKey({ key: 'ENTER' })
        expect(s.page.url()).equals(staffAddress)
        if (id == null) await shot('public-staff')
        for (const path of [
          '/games/gam_settings3_final',
          '/videos/vid_ui_tweaks/playback',
          '/games/gam_settings3_final/box-score'
        ]) {
          const response = await f.h.request('GET', path, undefined, id)
          logs.push(
            `GET ${path} as ${id == null ? 'anonymous' : 'nonmember'} => ${response.status}`
          )
          expect(response.status).equals(
            path === '/games/gam_settings3_final' ? 200 : id == null ? 401 : 403
          )
        }
      }
    await identity(101)
    for (const [name, path, expected] of [
      ['member-staff', `/teams/${f.teamA}?tab=team`, 'ADMINS'],
      ['relationship-cards', `/leagues/${f.leagueA}`, 'Winter Weekends'],
      ['season-teams-card', `/seasons/${f.seasonA}?tab=teams`, 'Orchard Owls'],
      [
        'manage-players-card',
        `/groups/team/${f.teamA}/settings`,
        'MANAGE PLAYERS'
      ],
      [
        'season-label',
        `/groups/season/${f.seasonA}/settings`,
        'Winter Weekends'
      ],
      [
        'team-add-game',
        `/teams/${f.teamA}?tab=schedule`,
        before ? 'Add Event' : 'Add Game'
      ]
    ]) {
      console.log('Capture', name)
      await open(path, expected)
      if (name === 'team-add-game' || name === 'manage-players-card')
        await s.m.scrollUntilVisible({
          element: { text: expected },
          direction: 'DOWN'
        })
      if (name === 'team-add-game') {
        const selector = before
          ? '[data-testid="add-event-card"]'
          : '[data-testid="add-game-button"]'
        for (let attempt = 0; attempt < 8; attempt++) {
          const top = await s.page.$eval(
            selector,
            node => node.getBoundingClientRect().top
          )
          if (top > 100 && top < 700) break
          await s.m.command('scroll', { direction: 'down' })
        }
        expect(
          await s.page.$eval(
            selector,
            node => node.getBoundingClientRect().bottom
          )
        ).lessThan(760)
      }
      await shot(name)
      if (!before && name === 'relationship-cards') {
        const ratios = await s.page.$$eval(
          '[data-testid="relationship-action-divider"]',
          nodes =>
            nodes.map(node => {
              const row = node.closest(
                '[data-testid="relationship-action-row"]'
              )!
              return (
                node.getBoundingClientRect().height /
                row.getBoundingClientRect().height
              )
            })
        )
        expect(ratios.length).greaterThan(0)
        for (const ratio of ratios) expect(ratio).closeTo(0.8, 0.02)
      }
    }
    if (!before) {
      const add = await s.page.$eval(
        '[data-testid="add-game-button"]',
        node => {
          const box = node.getBoundingClientRect()
          return {
            width: box.width,
            color: getComputedStyle(node).backgroundColor
          }
        }
      )
      expect(add.width).lessThan(250)
      await s.m.tapOn({ css: '[data-testid="add-game-button"]' })
      await contains(s.page, 'TIME ZONE')
      await s.m.tapOn({ css: '[data-testid="event-schedule-timezone"]' })
      await fill(s.m, 'Find time zone', 'Springfield')
      await contains(s.page, 'Illinois, United States')
      await shot('timezone-city')
      await s.m.tapOn({
        text: 'Use city Springfield, Illinois, United States',
        role: 'button'
      })
      await contains(s.page, 'America/Chicago')
      // Reopen scoring so the hero transition can be tested against real media.
      await f.h.db
        .updateTable('games')
        .set({
          status: 'inProgress',
          linescore: null,
          home_score: null,
          away_score: null
        })
        .where('id', '=', 'gam_settings3_final')
        .execute()
      await open('/games/gam_settings3_final?tab=watch', 'Highlights')
      await s.page.waitForSelector('video')
      await s.page
        .waitForFunction(
          () => {
            const v = document.querySelector('video')
            return v !== null && v.readyState >= 2
          },
          { timeout: 15000 }
        )
        .catch(async (error: unknown) => {
          console.log(
            'Video readiness',
            await s.page.$eval('video', v => ({
              ready: v.readyState,
              error: v.error == null ? undefined : v.error.message,
              duration: v.duration
            }))
          )
          throw error
        })
      const recorder = await s.page.screencast({
        path: join(out, 'member-playback.mp4') as `${string}.mp4`,
        format: 'mp4'
      })
      try {
        if (await s.page.$eval('video', video => video.paused))
          await s.m.pressKey({ key: 'SPACE' })
        await s.page.waitForFunction(
          () => {
            const v = document.querySelector('video')
            return v !== null && v.currentTime > 2 && !v.paused
          },
          { timeout: 30000 }
        )
        console.log('Member playback advancing')
        for (const { paused, browserBack } of [
          { paused: false, browserBack: false },
          { paused: true, browserBack: false },
          { paused: false, browserBack: true },
          { paused: true, browserBack: true }
        ]) {
          if ((await s.page.$eval('video', video => video.paused)) !== paused)
            await s.m.pressKey({ key: 'SPACE' })
          await s.page.waitForFunction(
            expected => {
              const video = document.querySelector('video')
              if (video == null) return false
              return video.paused === expected
            },
            {},
            paused
          )
          const time = await s.page.$eval('video', video => video.currentTime)
          await s.m.tapOn({ text: 'Score', role: 'button' })
          await contains(s.page, 'Full game scoring')
          expect(await s.page.$('[aria-label="Game sections"]')).equals(null)
          await shot('scoring-choices')
          if (browserBack) await s.page.goBack()
          else await s.m.tapOn({ text: 'Back', role: 'button' })
          await s.page.waitForFunction(
            ({ time, paused }) => {
              const video = document.querySelector('video')
              return (
                video != null &&
                video.readyState >= 2 &&
                video.currentTime >= time - 0.5 &&
                video.paused === paused
              )
            },
            { timeout: 30000 },
            { time, paused }
          )
          if (paused)
            expect(
              await s.page.$eval('video', video => video.currentTime)
            ).closeTo(time, 0.5)
        }
        console.log(
          'Score transition restored playing and paused video positions'
        )
        await cp(videoDir, join(mediaRoot, 'work/videos/vid_ui_alternate'), {
          recursive: true
        })
        await f.h.db
          .insertInto('videos')
          .values({
            id: 'vid_ui_alternate',
            game_id: 'gam_settings3_final',
            title: 'Alternate camera',
            kind: 'program',
            status: 'ready',
            storage: 'local',
            duration_sec: 90
          })
          .execute()
        await s.page.setViewport({ width: 844, height: 390 })
        await open('/games/gam_settings3_final?tab=watch', 'Alternate camera')
        for (const label of ['Score', 'Coach']) {
          await s.page.waitForFunction(
            label =>
              Array.from(
                document.querySelectorAll(
                  `[aria-label="${label}"][role="button"]`
                )
              ).some(node => {
                const box = node.getBoundingClientRect()
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  box.top >= 0 &&
                  box.bottom <= innerHeight
                )
              }),
            {},
            label
          )
        }
        const landscapeHeights: number[] = []
        for (let sample = 0; sample < 12; ++sample) {
          await new Promise(resolve => setTimeout(resolve, 100))
          landscapeHeights.push(
            await s.page.$eval(
              '[data-testid="event-pill-band"]',
              node => node.getBoundingClientRect().height
            )
          )
        }
        expect(new Set(landscapeHeights).size).equals(1)
        expect(landscapeHeights[0]).greaterThan(100)
        console.log(
          'Multi-camera landscape band remains stable',
          landscapeHeights
        )
        await shot('landscape-game-actions')
        await s.m.tapOn({ text: 'Score', role: 'button' })
        await contains(s.page, 'Full game scoring')
        await s.m.tapOn({ text: 'Back', role: 'button' })
        await s.page.setViewport({ width: 390, height: 844 })

        logs.push(
          'Member video currentTime advanced beyond 2 seconds through authorized media route.'
        )
      } finally {
        await recorder.stop()
      }
      expect(
        (
          await f.h.request(
            'GET',
            '/videos/vid_ui_tweaks/playback',
            undefined,
            101
          )
        ).status
      ).equals(200)
    }
    if (!before) {
      console.log('Create roster player through coach screen')
      await open(
        `/games/gam_settings3_scheduled/coach/${f.teamA}`,
        'Create Player'
      )
      await s.m.tapOn({ text: 'Roster', role: 'tab' })
      const countBefore = await f.h.db
        .selectFrom('users')
        .select('id')
        .execute()
      await s.m.tapOn({ text: 'Create Player', role: 'button' })
      await contains(s.page, 'Create Placeholder Player')
      await s.m.tapOn({ text: 'Create Placeholder Player', role: 'button' })
      await contains(s.page, 'Select number of players to create.')
      await s.m.tapOn({ text: 'Create', role: 'button' })
      expect(
        (await f.h.db.selectFrom('users').select('id').execute()).length
      ).equals(countBefore.length)
      // First save accepts an unseen lineup; second save extends a saved one.
      for (const [firstName, lastName] of [
        ['Mookie', 'Betts'],
        ['Mike', 'Trout']
      ]) {
        if (firstName === 'Mike')
          await s.m.tapOn({ text: 'Create Player', role: 'button' })
        await fill(s.m, 'First Name', firstName)
        await fill(s.m, 'Last Name', lastName)
        await s.m.tapOn({ css: '[role="dialog"] [aria-label="Create Player"]' })
        await s.page.waitForFunction(
          () => document.querySelector('[aria-label="First Name"]') === null
        )
        const created = await f.h.db
          .selectFrom('users')
          .select(['id', 'login_enabled'])
          .where('first_name', '=', firstName)
          .where('last_name', '=', lastName)
          .where(
            'id',
            'not in',
            countBefore.map(person => person.id)
          )
          .executeTakeFirstOrThrow()
        expect(created.login_enabled).equals(false)
        expect(
          await f.h.db
            .selectFrom('memberships')
            .select('user_id')
            .where('user_id', '=', created.id)
            .where('team_id', '=', f.teamA)
            .executeTakeFirst()
        ).not.equals(undefined)
        await s.m.tapOn({ text: 'Save Rosters', role: 'button' })
        await s.page.waitForFunction(
          () => {
            const button = document.querySelector('[aria-label="Save Rosters"]')
            if (button == null) return false
            return button.getAttribute('aria-disabled') === 'true'
          },
          { timeout: 30000 }
        )
        await contains(s.page, firstName)
        console.log('Created player remains after Save Rosters', firstName)
      }
      await open(
        `/games/gam_settings3_scheduled/coach/${f.teamA}`,
        'Create Player'
      )
      await s.m.tapOn({ text: 'Roster', role: 'tab' })
      await contains(s.page, 'Mookie')
      await contains(s.page, 'Mike')
      await open(`/teams/${f.teamA}?tab=team`, 'Mookie')
      await shot('roster-persistence')
      await writeFile(
        join(out, 'roster-creation.log'),
        '$ node -r sucrase/register src/app/uiTweaks.e2e.ts\nCoach screen Create Player persisted Mookie Betts and Mike Trout with login_enabled=false and team membership. Both saved into the game before/after an existing lineup and remained visible after editor remount and reopening.\nCreate Placeholder Player did not change the users count.\n'
      )
    }
    if (!before)
      await writeFile(join(out, 'public-access.log'), logs.join('\n') + '\n')
    if (!before) {
      await open('/game-actions-fixture.html', 'Record')
      await s.page.evaluate(async () => {
        await document.fonts.ready
      })
      for (const width of [320, 375, 390, 399, 400, 401, 414, 419, 420]) {
        await s.page.setViewport({ width, height: 844 })
        await s.page.waitForFunction(() => {
          const buttons = ['Score', 'Record', 'Coach'].map(label =>
            document.querySelector(`[role="button"][aria-label="${label}"]`)
          )
          return buttons.every(button => {
            if (button == null) return false
            const shell = button.firstElementChild!
            const label = shell.firstElementChild!
            const box = button.getBoundingClientRect()
            const shellBox = shell.getBoundingClientRect()
            const shellStyle = getComputedStyle(shell)
            const labelStyle = getComputedStyle(label)
            const context = document.createElement('canvas').getContext('2d')!
            context.font = labelStyle.font
            const textWidth = context.measureText(
              String(label.textContent)
            ).width
            const contentWidth =
              shellBox.width -
              parseFloat(shellStyle.paddingLeft) -
              parseFloat(shellStyle.paddingRight)
            return (
              box.height >= 48 &&
              box.left >= 0 &&
              box.right <= innerWidth &&
              label.textContent === button.getAttribute('aria-label') &&
              textWidth <= contentWidth &&
              parseFloat(getComputedStyle(shell).paddingLeft) >=
                shellBox.height / 2
            )
          })
        })
        await shot(`three-game-actions-${width}`)
      }
      await s.m.tapOn({ text: 'Record', role: 'button' })
      await contains(s.page, 'Action: Record')
      await s.m.tapOn({ text: 'Coach', role: 'button' })
      await contains(s.page, 'Action: Coach')
      await s.m.tapOn({ text: 'Score', role: 'button' })
      await contains(s.page, 'Full game scoring')
      console.log(
        'All three game actions fit at 320/375/390 and across the compact breakpoint (399/400/401/414/419/420) with 48-point targets and half-height pill padding; callbacks pass'
      )
    }
    console.log('UI tweaks browser assertions passed')
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
