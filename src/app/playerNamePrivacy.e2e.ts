import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import {
  absent,
  browserSession,
  capture,
  contains,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import type { PlayerNamePrivacy } from '../common/playerNamePrivacy'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { TESS_HEADER } from '../server/middleware/withAuth'
import { narrationsFor } from '../server/replay/narrationAudio'
import { groupFixture } from '../test/groupFixtures'
import {
  COACH,
  PARENT,
  SCOREKEEPER,
  seedPrivacyGame,
  SPRING_COACH,
  STRANGER,
  TEAMMATE,
  TROUT
} from '../test/playerNamePrivacyFixture'
import {
  dropPrefix,
  quiet,
  requireRedis,
  testPrefix,
  testStore
} from '../test/scoreboardKit'

/**
 * The finished app: an administrator sets player name privacy from the wheel
 * on each level's settings, and the public names follow it. A reader who may
 * read a player's full name reads it in full — Demo Hawks' coach on the
 * roster, the box score and his game screen, Alex's parent on Alex's page —
 * while a stranger, the scoring diamond and everything that leaves the
 * reader (the board, Tess, narration) keep the short name (E1–E5). Spring's
 * coach reads Mike Trout, a member of Spring who plays on none of its teams,
 * in full, and is still refused the name's halves, which are for editing
 * (P1).
 *
 * Run once with `TS_PRIVACY_BEFORE=1` on the base branch for the before
 * screenshots, and again without it:
 *
 *   npm run build.web
 *   MAESTRO_D_BIN=... TS_MAESTRO_D_CLIENT=... TS_CREATION_ARTIFACTS=<dir> \
 *     node -r sucrase/register src/app/playerNamePrivacy.e2e.ts
 */
const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Set TS_CREATION_ARTIFACTS')
const before = process.env.TS_PRIVACY_BEFORE === '1'

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const prefix = testPrefix()
  const redis = before ? undefined : await redisStore(prefix)
  const f = await groupFixture(
    resolve('dist'),
    undefined,
    undefined,
    undefined,
    {},
    {},
    redis == null ? undefined : { store: redis.store, log: quiet }
  )
  const { db, tokens, origin } = f.h
  const { ALEX, gameId } = await seedPrivacyGame(f)

  const daemon = await maestro(`playerNamePrivacy-${process.pid}`)
  const { browser, page, m } = await browserSession(
    daemon,
    `playerNamePrivacy-chromium-${process.pid}`,
    402,
    874,
    artifacts!
  )
  const signIn = async (userId: number): Promise<void> => {
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: tokens.get(userId)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
  }
  const open = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: origin + path })
    await contains(page, text)
  }
  const shoot = async (
    path: string,
    text: string,
    file: string
  ): Promise<void> => {
    await open(path, text)
    await capture(m, artifacts!, file)
  }
  /** What a teammate, who may read no full name, sees; then the admin again. */
  const publicly = async (read: () => Promise<void>): Promise<void> => {
    await signIn(TEAMMATE)
    await read()
    await signIn(101)
  }
  const LEAGUE = `/groups/league/${f.leagueA}/settings`
  const SPRING = `/groups/season/${f.seasonA}/settings`
  const FALL = `/groups/season/${f.playoffs}/settings`
  const COMPETING = `/groups/season/${f.seasonB}/settings`
  const TEAM = `/groups/team/${f.teamA}/settings`
  const ROSTER = `/teams/${f.teamA}?tab=team`
  const PLAYER = `/players/${userIdOfGumbo(ALEX)}`
  const BOX = `/games/${gameId}?tab=boxScore`
  /** The coach's own game screen, on its Lineup tab: `1. <name>` bats first. */
  const coachGame = async (name: string, file: string): Promise<void> => {
    await open(`/games/${gameId}/coach/${f.teamA}`, 'Batting — Demo Hawks')
    await m.tapOn({ css: '[aria-label="Lineup"]' })
    await contains(page, `1. ${name}`)
    await capture(m, artifacts!, file)
  }

  /** The wheel of the settings page open: spins to `stop` and presses Use. */
  const choose = async (row: string, stop: number): Promise<void> => {
    await m.tapOn({ css: `[aria-label^="Player Name Privacy, ${row}"]` })
    await contains(page, 'Show players as')
    await m.tapOn({ css: `[data-testid="player-name-privacy-${stop}"]` })
    await tap(m, 'Use')
    await absent(page, 'Show players as')
  }
  const setOn = async (
    path: string,
    row: string,
    stop: number,
    text: string
  ): Promise<void> => {
    await open(path, 'Player Name Privacy')
    await choose(row, stop)
    await contains(page, text)
  }

  /** The status of the last `logged` read. */
  let lastStatus = 0
  /** One read, as a `$` line and its answer, with no secrets. */
  const logged = async (
    file: string,
    line: string,
    route: string,
    userId?: number,
    headers: Record<string, string> = {}
  ): Promise<string> => {
    const answer = await fetch(`${origin}/api/v1${route}`, {
      headers: {
        ...(userId == null
          ? {}
          : { authorization: `Bearer ${tokens.get(userId)!}` }),
        ...headers
      }
    })
    const body = await answer.text()
    lastStatus = answer.status
    await appendFile(
      join(artifacts!, file),
      `$ ${line}\n${answer.status} ${body}\n\n`
    )
    return body
  }
  /**
   * The public names, as a teammate, who may read no full name, reads them:
   * the team's staff now read Alex in full whatever the format.
   */
  const publicNames = async (label: string): Promise<void> => {
    await appendFile(join(artifacts!, 'public-names.log'), `# ${label}\n`)
    const teammate = '-H "authorization: Bearer $TEAMMATE"'
    await logged(
      'public-names.log',
      `curl -s ${teammate} "$BASE/players/$ALEX?forTeam=$HAWKS"`,
      `/players/${userIdOfGumbo(ALEX)}?forTeam=${f.teamA}`,
      TEAMMATE
    )
    await logged(
      'public-names.log',
      `curl -s ${teammate} "$BASE/teams/$HAWKS/roster"`,
      `/teams/${f.teamA}/roster`,
      TEAMMATE
    )
    await logged(
      'public-names.log',
      'curl -s "$BASE/scoreboard/$GAME"',
      `/scoreboard/${gameId}`
    )
  }

  try {
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    })
    await signIn(101)
    if (before) {
      await shoot(LEAGUE, 'LEAGUE DETAILS', 'settings-league-before.png')
      await shoot(TEAM, 'TEAM DETAILS', 'settings-team-before.png')
      await shoot(ROSTER, 'Alex L', 'roster-before.png')
      await shoot(PLAYER, 'Alex L', 'player-page-before.png')
      await signIn(COACH)
      await shoot(TEAM, 'administrator', 'coach-settings-before.png')
      await shoot(ROSTER, 'Alex L', 'coach-roster-before.png')
      await shoot(BOX, 'Alex L', 'coach-box-score-before.png')
      await coachGame('Alex L', 'coach-game-before.png')
      await signIn(PARENT)
      await shoot(PLAYER, 'Alex L', 'parent-player-before.png')
      console.log('before screenshots captured')
      return
    }
    for (const log of [
      'public-names.log',
      'model-name.log',
      'full-name-read.log',
      'spoken-names.log',
      'reader-names.log',
      'outbound-names.log',
      'view-not-edit.log'
    ])
      await rm(join(artifacts!, log), { force: true })
    await publicNames('Nothing configured')

    // E1. The coach reads Alex Lee in full on the roster, the box score and
    // his game screen.
    const reader = 'reader-names.log'
    const hawks = `/teams/${f.teamA}/roster`
    const boxScore = `/games/${gameId}/box-score`
    const gameEvents = `/games/${gameId}/events`
    const asCoach = '-H "authorization: Bearer $COACH"'
    const asStranger = '-H "authorization: Bearer $STRANGER"'
    await signIn(COACH)
    await shoot(ROSTER, 'Alex Lee', 'coach-roster-after.png')
    await shoot(BOX, 'Alex Lee', 'coach-box-score-after.png')
    await coachGame('Alex Lee', 'coach-game-after.png')
    const coachRoster = await logged(
      reader,
      `curl -s ${asCoach} "$BASE/teams/$HAWKS/roster"`,
      hawks,
      COACH
    )
    expect(coachRoster).include('"shortName":"Alex Lee"')
    expect(coachRoster).include('"compactName":"Alex L"')
    expect(
      await logged(
        reader,
        `curl -s ${asCoach} "$BASE/games/$GAME/box-score"`,
        boxScore,
        COACH
      )
    ).include('Alex Lee')
    const coachEvents = await logged(
      reader,
      `curl -s ${asCoach} "$BASE/games/$GAME/events"`,
      gameEvents,
      COACH
    )
    expect(coachEvents).include('"readerNames"')
    expect(coachEvents).include('Alex Lee')
    console.log('E1 PASS: the coach reads Alex Lee on roster, box score, game')

    // E2. Alex's parent reads Alex in full, and a teammate he has no link to
    // by the public label.
    await signIn(PARENT)
    await shoot(PLAYER, 'Alex Lee', 'parent-player-after.png')
    await open(ROSTER, 'Mookie B')
    await contains(page, 'Alex Lee')
    await absent(page, 'Mookie Betts')
    const parentPlayer = await logged(
      reader,
      'curl -s -H "authorization: Bearer $PARENT" "$BASE/players/$ALEX"',
      `/players/${userIdOfGumbo(ALEX)}`,
      PARENT
    )
    expect(parentPlayer).include('Alex Lee')
    console.log('E2 PASS: the parent reads Alex Lee, and Mookie B')

    // E3. A stranger reads the public label.
    await signIn(STRANGER)
    await shoot(ROSTER, 'Alex L', 'stranger-roster-after.png')
    await absent(page, 'Alex Lee')
    // A stranger's box score names nobody: it asks him to join a team.
    await open(BOX, 'member of one of these teams')
    await absent(page, 'Alex Lee')
    const strangerRoster = await logged(
      reader,
      `curl -s ${asStranger} "$BASE/teams/$HAWKS/roster"`,
      hawks,
      STRANGER
    )
    expect(strangerRoster).include('"shortName":"Alex L"')
    for (const [line, route] of [
      [`curl -s ${asStranger} "$BASE/games/$GAME/box-score"`, boxScore],
      [`curl -s ${asStranger} "$BASE/games/$GAME/events"`, gameEvents]
    ])
      expect(await logged(reader, line, route, STRANGER)).not.include('Lee')
    expect(strangerRoster).not.include('Lee')
    console.log('E3 PASS: the stranger reads Alex L')

    // P1. Spring's coach reads Mike Trout, a member of Spring who plays on no
    // team of it, in full on Spring's people list and on his profile opened
    // from it, and still may not change his name. No player page: he plays
    // on no team the coach can see.
    await signIn(SPRING_COACH)
    await open(`/groups/season/${f.seasonA}?tab=people`, 'Mike Trout')
    await capture(m, artifacts!, 'spring-people-after.png')
    await m.tapOn({ text: 'Mike Trout' })
    await page.waitForFunction(() => location.pathname.includes('/people/'))
    await contains(page, 'Mike Trout')
    await capture(m, artifacts!, 'spring-profile-after.png')
    const view = 'view-not-edit.log'
    const asSpringCoach = '-H "authorization: Bearer $SPRING_COACH"'
    const trout = userIdOfGumbo(TROUT)
    expect(
      await logged(
        view,
        `curl -s ${asSpringCoach} "$BASE/seasons/$SPRING/people"`,
        `/seasons/${f.seasonA}/people`,
        SPRING_COACH
      )
    ).include('"shortName":"Mike Trout"')
    expect(
      await logged(
        view,
        `curl -s ${asSpringCoach} "$BASE/seasons/$SPRING/people/$TROUT"`,
        `/seasons/${f.seasonA}/people/${trout}`,
        SPRING_COACH
      )
    ).include('"fullName":"Mike Trout"')
    await logged(
      view,
      `curl -s ${asSpringCoach} "$BASE/players/$TROUT/name"`,
      `/players/${trout}/name`,
      SPRING_COACH
    )
    expect(lastStatus, 'the name halves are for editing').equals(404)
    console.log('P1 PASS: Spring’s coach reads Mike Trout, and may not edit it')

    // E5. Whatever leaves the reader stays short, after the coach's reads.
    const outbound = 'outbound-names.log'
    for (const [line, route, userId, headers] of [
      ['curl -s "$BASE/scoreboard/$GAME"', `/scoreboard/${gameId}`],
      [
        `curl -s ${asCoach} "$BASE/games/$GAME/box-score?view=board"`,
        `${boxScore}?view=board`,
        COACH
      ],
      [
        `curl -s ${asCoach} -H "${TESS_HEADER}: 1" "$BASE/teams/$HAWKS/roster"`,
        hawks,
        COACH,
        { [TESS_HEADER]: '1' }
      ]
    ] as const) {
      const body = await logged(outbound, line, route, userId, headers)
      expect(body, line).not.include('Lee')
    }
    const narrated = JSON.stringify([
      ...(await narrationsFor(db, gameId)).values()
    ])
    await appendFile(
      join(artifacts!, outbound),
      `$ narrationsFor $GAME  # in process, after the coach's reads\n${narrated}\n\n`
    )
    expect(narrated).include('Alex L')
    expect(narrated).not.include('Lee')
    console.log('E5 PASS: board, board view, Tess and narration stay short')

    // E4. The scorekeeper walks Alex: on first, the diamond names him by the
    // public label, while the lineup sheet reads him in full.
    await signIn(SCOREKEEPER)
    await open(`/games/${gameId}/score`, 'BUNT')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    for (let ball = 0; ball < 3; ball++) {
      await m.tapOn({ css: '[aria-label="Ball"]' })
      await m.waitForAnimationToEnd()
    }
    const plates = async (): Promise<string[]> =>
      await page.evaluate(() =>
        // Written for the page, where the test's own helpers are not.
        Array.from(document.querySelectorAll('[data-nameplate]')).map(plate =>
          String(plate.textContent)
        )
      )
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[data-nameplate]')).some(
        plate => plate.textContent === 'Alex L'
      )
    )
    expect((await plates()).filter(plate => plate.includes('Lee'))).deep.equals(
      []
    )
    await capture(m, artifacts!, 'scoring-overlay-after.png')
    await m.tapOn({ css: '[aria-label="Open scoring menu"]' })
    await tap(m, 'Set Team Rosters')
    await m.tapOn({ css: '[aria-label="Away Team"]' })
    await m.tapOn({ css: '[aria-label="Lineup"]' })
    await contains(page, '1. Alex Lee')
    await capture(m, artifacts!, 'scoring-lineup-after.png')
    console.log('E4 PASS: the diamond reads Alex L, the lineup sheet Alex Lee')
    await signIn(101)

    // 1. A league on Default has nothing to inherit from.
    await shoot(LEAGUE, 'Player Name Privacy', 'settings-league-after.png')
    await contains(page, 'First name, last initial')
    await absent(page, 'inherited from')
    console.log('1 PASS: league reads Default with no inherited-from line')

    // 2. The wheel, and Cancel changes nothing.
    await m.tapOn({ css: '[aria-label^="Player Name Privacy, Default"]' })
    await contains(page, 'Show players as')
    await capture(m, artifacts!, 'settings-wheel.png')
    await m.tapOn({ css: '[data-testid="player-name-privacy-4"]' })
    await capture(m, artifacts!, 'settings-wheel-end.png')
    for (const stop of [
      'Default',
      'First name, last initial',
      'First initial, last name',
      'First initial, last initial',
      'Full name'
    ])
      await contains(page, stop)
    await tap(m, 'Cancel')
    await page.reload()
    await contains(page, 'Player Name Privacy')
    await contains(page, 'Default')
    await capture(m, artifacts!, 'settings-cancelled.png')
    console.log('2 PASS: five stops, and Cancel stores nothing')

    // 3. Full name on the league.
    await setOn(LEAGUE, 'Default', 4, 'Full name')
    await page.reload()
    await contains(page, 'Full name')
    await absent(page, 'inherited from')
    await capture(m, artifacts!, 'settings-league-explicit.png')
    console.log('3 PASS: explicit value survives a reload')

    // 4. The team inherits it.
    await open(TEAM, 'Full name, inherited from Lakeshore')
    console.log('4 PASS: team inherits from the league')

    // 5. A managing season replaces the league.
    await open(SPRING, 'Full name, inherited from Lakeshore')
    await setOn(SPRING, 'Default', 1, 'First name, last initial')
    await open(TEAM, 'First name, last initial, inherited from Spring')
    await publicly(async () => {
      await open(ROSTER, 'Alex L')
    })
    console.log('5 PASS: a managing season replaces the league')

    // 6. The more restrictive of two managing seasons wins.
    await setOn(FALL, 'Default', 3, 'First initial, last initial')
    await setOn(SPRING, 'First name, last initial', 4, 'Full name')
    await shoot(
      TEAM,
      'First initial, last initial, inherited from Fall',
      'settings-team-after.png'
    )
    await publicly(async () => {
      await shoot(ROSTER, 'A L', 'roster-after.png')
      await shoot(PLAYER, 'A L', 'player-page-after.png')
    })
    await publicNames('Demo Hawks inherits First initial, last initial')
    console.log('6 PASS: the stricter managing season wins')

    // 7. A season the team only competes in changes nothing.
    await signIn(102)
    await setOn(COMPETING, 'Default', 4, 'Full name')
    await signIn(101)
    await shoot(
      TEAM,
      'First initial, last initial, inherited from Fall',
      'settings-team-competing.png'
    )
    console.log('7 PASS: a competing season contributes nothing')

    // 8. The team's own value replaces everything above it.
    await open(TEAM, 'Player Name Privacy')
    await choose('Default', 4)
    await contains(page, 'Full name')
    await publicly(async () => {
      await open(ROSTER, 'Alex Lee')
    })
    await publicNames('Demo Hawks set to Full name')
    console.log('8 PASS: an explicit team value wins')

    // 12. Whatever the format, no surname goes to a model.
    const spoken = 'spoken-names.log'
    const roster = `/teams/${f.teamA}/roster`
    const curl = 'curl -s -H "authorization: Bearer $SCOREKEEPER"'
    const clamped = await logged(
      spoken,
      `${curl} -H "${TESS_HEADER}: 1" "$BASE/teams/$HAWKS/roster"`,
      roster,
      SCOREKEEPER,
      { [TESS_HEADER]: '1' }
    )
    expect(clamped).include('"shortName":"Alex L"')
    expect(clamped).not.include('Alex Lee')
    const open_ = await logged(
      spoken,
      `${curl} "$BASE/teams/$HAWKS/roster"`,
      roster,
      SCOREKEEPER
    )
    expect(open_).include('"shortName":"Alex Lee"')
    const board = await logged(
      spoken,
      `curl -s -H "${TESS_HEADER}: 1" "$BASE/scoreboard/$GAME"`,
      `/scoreboard/${gameId}`,
      SCOREKEEPER,
      { [TESS_HEADER]: '1' }
    )
    expect(board).include('"batterName":""')
    const sentences = async (label: string): Promise<string> => {
      const said = JSON.stringify([
        ...(await narrationsFor(db, gameId)).values()
      ])
      await appendFile(
        join(artifacts!, spoken),
        `$ narrationsFor $GAME  # ${label}\n${said}\n\n`
      )
      return said
    }
    const full = await sentences('Demo Hawks on Full name')
    expect(full).include('Alex L')
    expect(full).not.include('Lee')
    console.log('12 PASS: a model reads no surname')

    // 9. A coach has no control.
    await signIn(COACH)
    await shoot(TEAM, 'administrator', 'coach-settings-after.png')
    await absent(page, 'Player Name Privacy')
    await signIn(101)
    console.log('9 PASS: a coach sees no row')

    // 10. Who may read the stored name still may.
    const setPublic = async (value: PlayerNamePrivacy): Promise<void> => {
      const answer = await f.h.request(
        'PUT',
        `/groups/team/${f.teamA}`,
        { playerNamePrivacy: value },
        101
      )
      expect(answer.status).equals(200)
    }
    await setPublic('initials')
    const initials = await sentences(
      'Demo Hawks on First initial, last initial'
    )
    expect(initials).include('A L')
    expect(initials).not.include('Alex')
    const reads = 'full-name-read.log'
    const nameRoute = `/players/${userIdOfGumbo(ALEX)}/name`
    expect(
      await logged(
        reads,
        `${curl} "$BASE/players/$ALEX/name"`,
        nameRoute,
        SCOREKEEPER
      )
    ).include('Lee')
    const managed = await logged(
      reads,
      `${curl} "$BASE/teams/$HAWKS/roster?includeFullNames=true"`,
      `${roster}?includeFullNames=true`,
      SCOREKEEPER
    )
    expect(managed).include('"lastName":"Lee"')
    // The scorekeeper may read him in full; the public label rides beside it.
    expect(managed).include('"shortName":"Alex Lee"')
    expect(managed).include('"compactName":"A L"')
    expect(
      await logged(reads, 'curl -s "$BASE/players/$ALEX/name"', nameRoute)
    ).include('unauthorized')
    await logged(
      reads,
      'curl -s -H "authorization: Bearer $STRANGER" "$BASE/players/$ALEX/name"',
      nameRoute,
      STRANGER
    )
    console.log('10 PASS: authorized reads are unchanged')

    // 11. Dictation stays first name and last initial.
    await f.h.request(
      'PUT',
      `/groups/team/${f.teamB}`,
      { playerNamePrivacy: 'initials' },
      102
    )
    const model = 'model-name.log'
    const events = `/games/${gameId}/events`
    const scorer = await logged(
      model,
      `${curl} "$BASE/games/$GAME/events"`,
      events,
      SCOREKEEPER
    )
    expect(scorer).include('"modelNames"')
    expect(scorer).include('Riley C.')
    const teammate = await logged(
      model,
      'curl -s -H "authorization: Bearer $TEAMMATE" "$BASE/games/$GAME/events"',
      events,
      TEAMMATE
    )
    // The teammate is answered the events (develop aa70c77db puts the
    // attributed scoring updates beside the plays), never a refusal.
    expect(JSON.parse(teammate)).to.have.property('plays').that.is.an('array')
    expect(teammate).not.include('modelNames')
    expect(teammate).not.include('firstName')
    expect(teammate).not.include('lastName')
    expect(teammate).not.include('Chen')
    expect(teammate).not.include('Riley')
    expect(
      await logged(model, 'curl -s "$BASE/games/$GAME/events"', events)
    ).include('unauthorized')
    console.log('11 PASS: only an admitted reader holds a model name')
  } finally {
    await browser.disconnect()
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
    await f.h.close()
    await redis?.close()
    await rm(join(artifacts!, 'support'), { recursive: true, force: true })
  }
}

async function redisStore(prefix: string): Promise<{
  store: Awaited<ReturnType<typeof testStore>>['store']
  close: () => Promise<void>
}> {
  await requireRedis()
  const { client, store } = await testStore(prefix)
  return {
    store,
    close: async () => {
      await client.close()
      await dropPrefix(prefix)
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
