import { type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import type { CDPSession, Page } from 'puppeteer'
import puppeteer, { type Browser } from 'puppeteer'

import { requireServerHost } from './actors'
import {
  type BrowserAccount,
  type CredentialsFile,
  readCredentials
} from './fixture'

/**
 * What a person does in the app, in a real browser, as the seeded people, on
 * real servers: creating, scoring, chatting, publishing, losing access. It
 * reads who they are from `credentials.json`, so it needs no database.
 *
 *   node -r sucrase/register tools/dbLoad/functional.ts \
 *     --server https://one.example.test --server https://two.example.test \
 *     --credentials credentials.json \
 *     --publish-command 'node tools/streamTestPattern.js --url {url} --duration {duration} --codec libx265' \
 *     [--restart-command <cmd>] [--valkey-block-command <cmd>] [--report functional.log] [--only <action>]
 *
 * `--publish-command` is a template of `{url}` and `{duration}`. On a machine
 * that may not reach the ingest it is an `ssh -tt` to one that can, since ending
 * a terminal's session also stops what it ran. Each `--server` is a site: its
 * web app and its API on one origin. The stream host, which every node names in
 * the URLs it mints, must be one of them, or the stream is refused.
 *
 * Every action is reported by name with what it saw, and any failure fails the
 * run; an action this run cannot do says so as skipped.
 */

export interface Answer {
  status: number
  body: unknown
}

/** One person's browser tab, in the terms the actions use. */
export interface Surface {
  open: (path: string) => Promise<void>
  /**
   * Presses the control with this label; one ending in `*` matches its start,
   * and `Group > Label` is one inside the group that has that label.
   */
  press: (label: string) => Promise<void>
  fill: (label: string, value: string) => Promise<void>
  has: (label: string) => Promise<boolean>
  text: () => Promise<string>
  /** Fails if the words do not appear on the screen in time. */
  waitForText: (words: string, ms?: number) => Promise<void>
  waitForLabel: (label: string, ms?: number) => Promise<void>
  /** A request as this tab makes them, with its own session. */
  api: (method: string, path: string, body?: unknown) => Promise<Answer>
  /** Every frame this tab's sockets have received, oldest first. */
  frames: () => unknown[]
  /** Whether a video on the screen is advancing, or this browser cannot. */
  videoPlayback: (ms?: number) => Promise<Playback>
  close: () => Promise<void>
}

export type Playback = 'plays' | 'undecodable' | 'stalled'

export interface Driver {
  /** A tab signed in as somebody on a server, through the sign-in screen. */
  signIn: (account: BrowserAccount, server: string) => Promise<Surface>
  close: () => Promise<void>
}

export type RunCommand = (template: string, values: Values) => RunningCommand
export type Values = Record<string, string>

export interface RunningCommand {
  /** Asks it to end, then makes it, and resolves when it has gone. */
  stop: () => Promise<void>
  /** Resolves with its exit code when it ends by itself. */
  done: Promise<number>
}

export interface Context {
  servers: string[]
  credentials: CredentialsFile
  driver: Driver
  /** Tabs already signed in, by who and where. */
  tabs: Map<string, Surface>
  publishCommand?: string
  restartCommand?: string
  valkeyBlockCommand?: string
  run: RunCommand
  /** Between looks at something that takes time to happen. */
  pollMs: number
  /** How long something that takes time to happen is given. */
  patienceMs: number
  /** Pitches scored so far, shared by the actions that score. */
  pitches: number
}

export class Skip extends Error {}

export type ActionResult = {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  ms: number
  detail: string
}

export interface Action {
  name: string
  run: (context: Context) => Promise<string>
}

/** A person's first tab on a server, or the one already open. */
async function tabOf(
  context: Context,
  label: string,
  server = context.servers[0]
): Promise<Surface> {
  const key = `${label}\u0000${server}`
  const held = context.tabs.get(key)
  if (held != null) return held
  const account = accountOf(context, label)
  const tab = await context.driver.signIn(account, server)
  context.tabs.set(key, tab)
  return tab
}

function accountOf(context: Context, label: string): BrowserAccount {
  const account = context.credentials.accounts.find(row => row.label === label)
  if (account == null) throw new Error(`credentials have no ${label}`)
  return account
}

/** The other node, or the same one when the run has only one. */
const farServer = (context: Context): string =>
  context.servers[context.servers.length - 1]

async function waitUntil<T>(
  context: Context,
  what: string,
  look: () => Promise<T | undefined | false>
): Promise<T> {
  const end = Date.now() + context.patienceMs
  for (;;) {
    const seen = await look()
    if (seen !== undefined && seen !== false) return seen
    if (Date.now() > end) throw new Error(`Gave up waiting for ${what}`)
    await new Promise(done => {
      setTimeout(done, context.pollMs)
    })
  }
}

function okBody(answer: Answer, what: string): any {
  if (answer.status >= 400)
    throw new Error(
      `${what}: HTTP ${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`
    )
  return answer.body
}

/** What one change frame says of the batter at the plate. */
export interface PitchMark {
  atBat: number
  pitches: number
}

/** The pitches a tab was told about, in the order it was told. */
export function pitchMarks(frames: unknown[], gameId: string): PitchMark[] {
  const marks: PitchMark[] = []
  for (const raw of frames) {
    const frame = raw as {
      type?: string
      gameId?: string
      kind?: string
      data?: {
        currentPlay?: {
          about?: { atBatIndex?: number }
          playEvents?: Array<{ isPitch?: boolean }>
        } | null
      }
    }
    if (frame.type !== 'change' || frame.gameId !== gameId) continue
    if (frame.kind !== 'plays') continue
    const play = frame.data?.currentPlay
    if (play == null) continue
    marks.push({
      atBat: play.about?.atBatIndex ?? 0,
      pitches: (play.playEvents ?? []).filter(row => row.isPitch === true)
        .length
    })
  }
  return marks
}

/** Where a mark goes backwards, or undefined when each follows in order. */
export function outOfOrder(marks: PitchMark[]): string | undefined {
  for (let i = 1; i < marks.length; i++) {
    const was = marks[i - 1]
    const now = marks[i]
    if (
      now.atBat < was.atBat ||
      (now.atBat === was.atBat && now.pitches < was.pitches)
    )
      return `frame ${i}: at bat ${now.atBat} pitch ${now.pitches} after at bat ${was.atBat} pitch ${was.pitches}`
  }
  return undefined
}

/** Opens the scoring screen with today's rosters set. */
async function openScoring(context: Context): Promise<Surface> {
  const { liveGameId } = context.credentials.places
  const scorer = await tabOf(context, 'browser.scorekeeper')
  await scorer.open(`/games/${liveGameId}/score`)
  await scorer.waitForLabel('Open scoring menu', context.patienceMs)
  return scorer
}

const PITCH_CALLS = ['Ball', 'Called Strike', 'Ball', 'Swing and Miss']

/**
 * Scores `count` pitches, waiting after each until the far tab has heard of it,
 * and answers how many of them it heard.
 */
async function scorePitches(
  context: Context,
  scorer: Surface,
  watcher: Surface,
  count: number
): Promise<number> {
  const { liveGameId } = context.credentials.places
  let heard = 0
  for (let i = 0; i < count; i++) {
    const before = pitchMarks(watcher.frames(), liveGameId).length
    await scorer.press(PITCH_CALLS[context.pitches % PITCH_CALLS.length])
    context.pitches += 1
    await waitUntil(
      context,
      `pitch ${context.pitches} to reach the far node`,
      async () => pitchMarks(watcher.frames(), liveGameId).length > before
    )
    heard += 1
  }
  return heard
}

/**
 * After a disruption: pitches, until the far node hears one. A client coming back
 * reads what it missed rather than being sent it, so a pitch scored before its
 * socket returned is never a frame, and only a later one shows the view is live.
 */
async function scoreUntilHeard(
  context: Context,
  scorer: Surface,
  watcher: Surface
): Promise<void> {
  const { liveGameId } = context.credentials.places
  const end = Date.now() + context.patienceMs
  for (;;) {
    const before = pitchMarks(watcher.frames(), liveGameId).length
    await scorer.press(PITCH_CALLS[context.pitches % PITCH_CALLS.length])
    context.pitches += 1
    const nextPitch = Date.now() + Math.min(10000, context.patienceMs)
    while (Date.now() < nextPitch) {
      if (pitchMarks(watcher.frames(), liveGameId).length > before) return
      await new Promise(done => {
        setTimeout(done, context.pollMs)
      })
    }
    if (Date.now() > end)
      throw new Error(`Gave up waiting for a pitch to reach the far node`)
  }
}

/** A tab watching the live game, with its socket subscribed. */
async function watching(
  context: Context,
  label: string,
  server: string
): Promise<Surface> {
  const { liveGameId } = context.credentials.places
  const tab = await tabOf(context, label, server)
  await tab.open(`/games/${liveGameId}`)
  await tab.waitForLabel('Game sections', context.patienceMs)
  return tab
}

const signInByPassword: Action = {
  name: 'sign in by password',
  run: async context => {
    const who = [
      'person.admin',
      'person.coach',
      'browser.scorekeeper',
      'person.guardian',
      'browser.viewer'
    ]
    for (const label of who) {
      const tab = await tabOf(context, label)
      await tab.waitForLabel('Account,*', context.patienceMs)
    }
    return `${who.join(', ')} on ${context.servers[0]}`
  }
}

const createTeamSeasonGame: Action = {
  name: 'create a team, season and game',
  run: async context => {
    const { leagueId, liveTeamId } = context.credentials.places
    const admin = await tabOf(context, 'person.admin')
    const stamp = Date.now().toString(36)
    const teamName = `Functional team ${stamp}`
    await admin.open('/create/team')
    await admin.fill('Team name', teamName)
    await admin.press('Continue')
    await admin.press('Location not set, Add a city')
    await admin.fill('City', 'tor')
    await admin.press('Choose Toronto*')
    await admin.press('Save')
    await admin.press('Continue')
    await admin.press('Use initials')
    await admin.press('Continue')
    await admin.press('Create Team')
    await admin.waitForLabel('Team sections', context.patienceMs)
    await admin.waitForText(teamName, context.patienceMs)

    const seasonName = `Functional season ${stamp}`
    await admin.open(`/groups/league/${leagueId}`)
    await admin.press('Create season')
    await admin.fill('Season name', seasonName)
    await admin.press('Continue')
    // Four terms from today are offered, so one of them is always a spring.
    await admin.press('Spring*')
    await admin.press('Continue')
    await admin.press('Use initials')
    await admin.press('Create Season')
    await admin.waitForLabel('Season settings', context.patienceMs)
    await admin.waitForText(seasonName, context.patienceMs)

    await admin.open(`/groups/team/${liveTeamId}/create-game`)
    await admin.press('Choose Away Team, Away')
    await admin.fill('Search all teams', teamName)
    await admin.press(`Choose ${teamName}`)
    await admin.press('Save')
    await admin.waitForLabel('Game sections', context.patienceMs)
    return `${teamName}, ${seasonName} and a game against it`
  }
}

const rolesSeeTheirOwn: Action = {
  name: 'each kind of account sees what its role allows',
  run: async context => {
    const { liveGameId } = context.credentials.places
    const seen: string[] = []
    const expectation = async (
      label: string,
      control: string,
      wanted: boolean
    ): Promise<void> => {
      const tab = await watching(context, label, context.servers[0])
      const has = await tab.has(control)
      seen.push(`${label} ${has ? 'has' : 'lacks'} ${control}`)
      if (has !== wanted)
        throw new Error(
          `${label} should ${wanted ? '' : 'not '}have ${control}`
        )
    }
    await expectation('browser.scorekeeper', 'Score', true)
    await expectation('browser.viewer', 'Score', false)
    const { liveTeamId } = context.credentials.places
    const coachScreen = `/games/${liveGameId}/coach/${liveTeamId}`
    const coach = await tabOf(context, 'browser.coach')
    await coach.open(coachScreen)
    await coach.waitForText('Batting', context.patienceMs)
    const viewer = await tabOf(context, 'browser.viewer')
    await viewer.open(coachScreen)
    await viewer.waitForText('Only a head coach', context.patienceMs)
    seen.push('the coach has the coaching screen, a viewer is refused it')
    const { childId } = context.credentials.places
    const guardian = await tabOf(context, 'person.guardian')
    const child = await guardian.api('GET', `/players/${childId}/stats`)
    seen.push(`the guardian reads the child: HTTP ${child.status}`)
    if (child.status >= 400)
      throw new Error('The guardian cannot read the child')
    const stranger = await tabOf(context, 'person.stranger')
    const answer = await stranger.api('GET', `/games/${liveGameId}/events`)
    seen.push(`person.stranger reads the game's plays: HTTP ${answer.status}`)
    if (answer.status < 400)
      throw new Error('person.stranger read a game that is not theirs')
    return seen.join('; ')
  }
}

const scoreAcrossNodes: Action = {
  name: 'score a game with viewers on the other node',
  run: async context => {
    const { liveGameId } = context.credentials.places
    const watcher = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    const scorer = await openScoring(context)
    await scorer.waitForLabel('Ball', context.patienceMs)
    const heard = await scorePitches(context, scorer, watcher, 8)
    const marks = pitchMarks(watcher.frames(), liveGameId)
    const wrong = outOfOrder(marks)
    if (wrong != null) throw new Error(`Pitches out of order: ${wrong}`)
    return `${heard} pitches heard on ${farServer(context)}, ${marks.length} frames, all in order`
  }
}

const editLineup: Action = {
  name: 'edit a lineup mid-game',
  run: async context => {
    const { liveGameId } = context.credentials.places
    const watcher = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    const before = watcher.frames().length
    const scorer = await openScoring(context)
    await scorer.press('Open scoring menu')
    await scorer.press('Set Team Rosters')
    await scorer.press('Create Player')
    const last = `Functional${Date.now().toString(36)}`
    await scorer.fill('First Name', 'Late')
    await scorer.fill('Last Name', last)
    await scorer.press('Create Player')
    await scorer.press('Save Rosters')
    await scorer.waitForLabel('Ball', context.patienceMs)
    await scorePitches(context, scorer, watcher, 1)
    // A post tells of its plays, then its game, then its lineups, so the pitch
    // heard above comes before the lineups it carried.
    const since = (): Array<{ kind?: string }> =>
      watcher.frames().slice(before) as Array<{ kind?: string }>
    await waitUntil(
      context,
      'the far node to hear of a change of lineup',
      async () => since().some(frame => frame.kind === 'lineups')
    ).catch(() => {
      throw new Error(
        `The far node heard of no change of lineup, in ${since().length} frames: ${[...new Set(since().map(frame => frame.kind))].join(', ')}`
      )
    })
    const after = since()
    const answer = okBody(
      await watcher.api('GET', `/games/${liveGameId}/events`),
      'reading plays after the edit'
    ) as { lineups?: unknown; plays?: unknown[] }
    return `lineups saved mid-game; ${after.length} frames since; ${answer.plays?.length ?? 0} plays stored`
  }
}

const boxScoreAndStats: Action = {
  name: 'box score and stats after the stats builder',
  run: async context => {
    const { liveGameId, finishedTeamId } = context.credentials.places
    const viewer = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    await viewer.press('Game sections > Box score')
    await viewer.waitForText('AB', context.patienceMs)
    const box = okBody(
      await viewer.api('GET', `/games/${liveGameId}/box-score`),
      'the box score'
    )
    if (box == null) throw new Error('The box score is empty')
    const admin = await tabOf(context, 'person.admin')
    const lines = await waitUntil(context, 'team stats', async () => {
      const stats = okBody(
        await admin.api('GET', `/teams/${finishedTeamId}/stats`),
        'the team stats'
      ) as unknown[]
      return stats.length > 0 ? stats.length : undefined
    })
    return `the live box score reads, a finished team's built stats have ${lines} lines`
  }
}

const mergedPlayerStats: Action = {
  name: "a merged player's stats",
  run: async context => {
    const { mergedPlayerId, mergedPlayerGames } = context.credentials.places
    const admin = await tabOf(context, 'person.admin')
    const stats = okBody(
      await admin.api('GET', `/players/${mergedPlayerId}/stats`),
      'the merged player'
    ) as { games?: number }
    const games = stats.games ?? 0
    if (games < mergedPlayerGames)
      throw new Error(
        `The kept row has ${games} games, not his ${mergedPlayerGames}`
      )
    await admin.open(`/players/${mergedPlayerId}`)
    await admin.press('Player sections > Stats')
    await admin.waitForText('AB', context.patienceMs)
    return `${games} games under the kept row, shown on his screen`
  }
}

/** Two people in a team's chat on different nodes, typing and sending. */
async function chatBetween(
  context: Context,
  teamId: string,
  chatLabel: string,
  writer: string,
  reader: string
): Promise<string> {
  const sender = await tabOf(context, writer)
  const receiver = await tabOf(context, reader, farServer(context))
  await receiver.open('/chat')
  await receiver.press(`${chatLabel}*`)
  await receiver.waitForLabel('Message', context.patienceMs)
  await sender.open('/chat')
  await sender.press(`${chatLabel}*`)
  await sender.waitForLabel('Message', context.patienceMs)
  const words = `Functional check ${teamId.slice(-4)} ${Date.now().toString(36)}`
  await sender.fill('Message', words)
  await receiver.waitForText('typing', context.patienceMs)
  await sender.press('Send')
  await receiver.waitForText(words, context.patienceMs)
  return `${writer} typed and sent, ${reader} saw both on ${farServer(context)}`
}

const chatAndTyping: Action = {
  name: 'send chat and see typing across nodes',
  run: async context =>
    await chatBetween(
      context,
      context.credentials.places.teamChatTeamId,
      'Load browser.talkTeam Members',
      'browser.viewer',
      'browser.viewerAway'
    )
}

const chatWithMerged: Action = {
  name: 'a chat holding a merged member',
  run: async context =>
    await chatBetween(
      context,
      context.credentials.places.mergedChatTeamId,
      'Load browser.chatTeam Members',
      'browser.chatFriend',
      'browser.chatKept'
    )
}

const revokeViewer: Action = {
  name: 'revoke a viewer mid-game',
  run: async context => {
    const { liveGameId } = context.credentials.places
    const revoked = accountOf(context, 'browser.revoked')
    const tab = await watching(context, 'browser.revoked', farServer(context))
    const framesAtRevoke = pitchMarks(tab.frames(), liveGameId).length
    const admin = await tabOf(context, 'person.admin')
    okBody(
      await admin.api('PATCH', `/users/${revoked.userId}/administration`, {
        suspended: true
      }),
      'suspending the account'
    )
    const scorer = await openScoring(context)
    const watcher = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    await scorePitches(context, scorer, watcher, 1)
    const answer = await tab.api('GET', `/games/${liveGameId}/events`)
    if (answer.status !== 401)
      throw new Error(`A revoked session read the game: HTTP ${answer.status}`)
    const heard = pitchMarks(tab.frames(), liveGameId).length - framesAtRevoke
    if (heard > 0) throw new Error(`The revoked viewer heard ${heard} pitches`)
    return 'the revoked viewer hears no further pitches, and its reads answer 401'
  }
}

const removeMember: Action = {
  name: 'remove a member mid-game',
  run: async context => {
    const { liveGameId, liveTeamId } = context.credentials.places
    const removed = accountOf(context, 'browser.removed')
    const tab = await watching(context, 'browser.removed', farServer(context))
    const admin = await tabOf(context, 'person.admin')
    okBody(
      await admin.api(
        'DELETE',
        `/manage/team/${liveTeamId}/people/${removed.userId}`
      ),
      'removing the member'
    )
    const framesAtRemoval = pitchMarks(tab.frames(), liveGameId).length
    const scorer = await openScoring(context)
    const watcher = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    await scorePitches(context, scorer, watcher, 1)
    const heard = pitchMarks(tab.frames(), liveGameId).length - framesAtRemoval
    if (heard > 0) throw new Error(`The removed member heard ${heard} pitches`)
    return 'the removed member hears no further pitches'
  }
}

/** Quotes a value for the shell that runs a template. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** A template with each `{name}` replaced, quoted for the shell. */
export function fillTemplate(template: string, values: Values): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? shellQuote(values[name]) : whole
  )
}

/**
 * Runs a command line in its own process group, so that ending it ends whatever
 * it started. Its output is dropped, since a stream URL is a secret.
 */
export const runCommand: RunCommand = (template, values) => {
  const child: ChildProcess = spawn(
    'sh',
    ['-c', fillTemplate(template, values)],
    { detached: true, stdio: 'ignore' }
  )
  const done = new Promise<number>(resolve => {
    child.on('close', code => {
      resolve(code ?? 1)
    })
    child.on('error', () => {
      resolve(1)
    })
  })
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (child.pid != null) process.kill(-child.pid, name)
    } catch {
      // It has already gone.
    }
  }
  return {
    done,
    stop: async () => {
      signal('SIGINT')
      const forced = setTimeout(() => {
        signal('SIGKILL')
      }, 5000)
      await done
      clearTimeout(forced)
    }
  }
}

/** How long a test stream is told to last, if nothing ends it first. */
const PUBLISH_SECONDS = 180

/** What the server says of one of this person's streams. */
async function streamState(
  camera: Surface,
  gameId: string,
  streamId: string
): Promise<string | undefined> {
  const streams = okBody(
    await camera.api('GET', `/games/${gameId}/live-streams`),
    'reading streams'
  ) as { mine: Array<{ id: string; state: string }> }
  return streams.mine.find(row => row.id === streamId)?.state
}

const publishAndWatch: Action = {
  name: 'publish, watch live from both nodes, end it and play the recording',
  run: async context => {
    if (context.publishCommand == null)
      throw new Skip('No --publish-command was given')
    const { liveGameId } = context.credentials.places
    const camera = await tabOf(context, 'browser.videographer')
    const created = okBody(
      await camera.api('POST', `/games/${liveGameId}/live-streams`, {}),
      'creating a stream'
    ) as { id: string }
    const revealed = okBody(
      await camera.api(
        'POST',
        `/games/${liveGameId}/live-streams/${created.id}/reveal`
      ),
      'revealing its URL'
    ) as { url: string }
    requireServerHost(revealed.url, context.servers)
    const publishing = context.run(context.publishCommand, {
      url: revealed.url,
      duration: String(PUBLISH_SECONDS)
    })
    const end = async (): Promise<void> => {
      await publishing.stop()
      okBody(
        await camera.api(
          'POST',
          `/games/${liveGameId}/live-streams/${created.id}/end`
        ),
        'ending the stream'
      )
    }
    /** Fails on a video that stalls, and says when this browser cannot tell. */
    const watch = async (viewer: Surface, what: string): Promise<boolean> => {
      await viewer.press('Game sections > Videos')
      const playback = await viewer.videoPlayback(context.patienceMs)
      if (playback === 'stalled') throw new Error(`${what} does not play`)
      return playback === 'undecodable'
    }
    let undecodable = false
    try {
      await waitUntil(context, 'the stream to go live', async () =>
        (await streamState(camera, liveGameId, created.id)) === 'publishing'
          ? true
          : undefined
      )
      for (const [i, server] of context.servers.entries()) {
        const viewer = await watching(
          context,
          i === 0 ? 'browser.viewer' : 'browser.viewerAway',
          server
        )
        await viewer.waitForLabel('Live now', context.patienceMs)
        if (await watch(viewer, `The live video on ${server}`))
          undecodable = true
      }
    } catch (error) {
      await end().catch(() => undefined)
      throw error
    }
    await end()
    await waitUntil(context, 'the stream to end', async () =>
      (await streamState(camera, liveGameId, created.id)) === 'publishing'
        ? undefined
        : true
    )
    const viewer = await watching(
      context,
      'browser.viewerAway',
      farServer(context)
    )
    if (await watch(viewer, 'The recording')) undecodable = true
    const done = `published, shown live on ${context.servers.length} node(s), and ended`
    if (undecodable)
      throw new Skip(
        `${done}; playback is not proved, because this browser has no decoder for the stream's HEVC`
      )
    return `${done}; the live video and the recording both play`
  }
}

const analytics: Action = {
  name: 'view Analytics as admin',
  run: async context => {
    const admin = await tabOf(context, 'person.admin')
    const asked = {
      sql: 'select count(*) as events from analytics.events',
      parameters: []
    }
    const answer = okBody(
      await admin.api('POST', '/admin/analytics/query', asked),
      'the analytics query'
    ) as { rows?: unknown[] }
    const viewer = await tabOf(context, 'browser.viewer')
    const refused = await viewer.api('POST', '/admin/analytics/query', asked)
    if (refused.status < 400)
      throw new Error('A viewer was answered an analytics query')
    return `the query answered ${answer.rows?.length ?? 0} rows, and a viewer is refused`
  }
}

const schedule: Action = {
  name: 'open the schedule',
  run: async context => {
    const viewer = await tabOf(context, 'browser.viewer')
    await viewer.open('/schedule')
    await viewer.waitForText('Load', context.patienceMs)
    return 'the schedule lists games'
  }
}

const finishedScreens: Action = {
  name: 'open a finished game, team and large box score',
  run: async context => {
    const { finishedGameId, finishedTeamId, largeGameId } =
      context.credentials.places
    const admin = await tabOf(context, 'person.admin')
    await admin.open(`/games/${finishedGameId}`)
    await admin.waitForText('Final', context.patienceMs)
    await admin.open(`/groups/team/${finishedTeamId}`)
    await admin.waitForText('finished.home', context.patienceMs)
    await admin.open(`/games/${largeGameId}`)
    await admin.press('Game sections > Box score')
    await admin.waitForText('AB', context.patienceMs)
    return 'each opened with its content'
  }
}

const chatReconciles: Action = {
  name: 'let a chat audience reconcile',
  run: async context => {
    const { liveTeamId } = context.credentials.places
    const removed = await tabOf(context, 'browser.removed')
    await waitUntil(
      context,
      'the removed member to leave the chat',
      async () => {
        const list = okBody(
          await removed.api('GET', '/chat/conversations'),
          'the chat list'
        )
        return JSON.stringify(list).includes(liveTeamId) ? undefined : true
      }
    )
    return "the team's chat left the removed member's list"
  }
}

/** The app is still live after a disruption: a pitch reaches the far node. */
async function liveAfter(
  context: Context,
  template: string | undefined,
  flag: string
): Promise<string> {
  if (template == null) throw new Skip(`No ${flag} was given`)
  const scorer = await openScoring(context)
  const watcher = await watching(
    context,
    'browser.viewerAway',
    farServer(context)
  )
  const code = await context.run(template, {}).done
  if (code !== 0) throw new Error(`${flag} exited ${code}`)
  const started = Date.now()
  await scorer.waitForLabel('Ball', context.patienceMs)
  await scoreUntilHeard(context, scorer, watcher)
  return `a pitch reached the far node ${((Date.now() - started) / 1000).toFixed(1)} s later`
}

const restartNode: Action = {
  name: 'restart an API node mid-game',
  run: async context =>
    await liveAfter(context, context.restartCommand, '--restart-command')
}

const blockValkey: Action = {
  name: 'block Valkey for 20 s',
  run: async context =>
    await liveAfter(
      context,
      context.valkeyBlockCommand,
      '--valkey-block-command'
    )
}

/** In order: each may use what those before it left. */
export const ACTIONS: Action[] = [
  signInByPassword,
  createTeamSeasonGame,
  rolesSeeTheirOwn,
  scoreAcrossNodes,
  editLineup,
  boxScoreAndStats,
  mergedPlayerStats,
  chatAndTyping,
  chatWithMerged,
  revokeViewer,
  removeMember,
  publishAndWatch,
  analytics,
  schedule,
  finishedScreens,
  chatReconciles,
  restartNode,
  blockValkey
]

/** Runs each action to its result, so one failure hides nothing after it. */
export async function runActions(
  actions: Action[],
  context: Context,
  log: (line: string) => void
): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (const action of actions) {
    const started = performance.now()
    let status: ActionResult['status'] = 'passed'
    let detail: string
    try {
      detail = await action.run(context)
    } catch (error) {
      status = error instanceof Skip ? 'skipped' : 'failed'
      detail = (error as Error).message
    }
    const result = {
      name: action.name,
      status,
      ms: performance.now() - started,
      detail
    }
    results.push(result)
    log(renderResult(result))
  }
  return results
}

export function renderResult(result: ActionResult): string {
  return `${result.status.toUpperCase()} ${result.name} (${(result.ms / 1000).toFixed(1)} s): ${result.detail}`
}

export function renderSummary(results: ActionResult[]): string {
  const count = (status: ActionResult['status']): number =>
    results.filter(row => row.status === status).length
  return `${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`
}

/**
 * Finds the last visible control so named: by its label, or by its words if it
 * has none. A name ending in `*` is its start. Plain text, because a page
 * function is not given the helpers this tool's compiler writes.
 */
const FIND_CONTROL = `function (wanted, enabled) {
  var path = wanted.split(' > ')
  var name = path[path.length - 1]
  var prefix = name.endsWith('*') ? name.slice(0, -1) : null
  var root = path.length > 1
    ? document.querySelector('[aria-label="' + path[0] + '"]')
    : document
  if (root === null) return null
  var nodes = root.querySelectorAll('[aria-label], [role="button"], [role="tab"], a')
  var found = null
  nodes.forEach(function (node) {
    var own = node.hasAttribute('aria-label')
      ? node.getAttribute('aria-label')
      : (node.textContent || '').trim()
    var named = prefix === null ? own === name : own.indexOf(prefix) === 0
    if (!named || !node.checkVisibility()) return
    if (enabled && node.getAttribute('aria-disabled') === 'true') return
    found = node
  })
  return found
}`
const present = new Function(
  'wanted',
  `return (${FIND_CONTROL})(wanted, false) !== null`
) as (wanted: string) => boolean
const pressable = new Function(
  'wanted',
  `return (${FIND_CONTROL})(wanted, true) !== null`
) as (wanted: string) => boolean

/**
 * How often a tab looks again. By the clock and not by animation frame, which a
 * software-drawn 3D field on a box without a graphics card can hold up for long.
 */
const POLL_MS = 200

/** A real browser's tab, signed in through the screen a person uses. */
class BrowserSurface implements Surface {
  private readonly seen: unknown[] = []

  constructor(
    private readonly page: Page,
    private readonly server: string,
    private readonly patienceMs: number
  ) {}

  /** A wait that says, when it fails, what it wanted and what it saw instead. */
  private async waited(what: string, waiting: Promise<unknown>): Promise<void> {
    try {
      await waiting
    } catch (error) {
      if ((error as Error).name !== 'TimeoutError') throw error
      const screen = (await this.text()).replace(/\s+/g, ' ').slice(0, 300)
      throw new Error(
        `No ${what} at ${new URL(this.page.url()).pathname}, on a screen saying: ${screen}`
      )
    }
  }

  async listen(): Promise<void> {
    const session: CDPSession = await this.page.createCDPSession()
    await session.send('Network.enable')
    session.on('Network.webSocketFrameReceived', event => {
      try {
        this.seen.push(JSON.parse(event.response.payloadData))
      } catch {
        // Not one of ours: the app's frames are all JSON.
      }
    })
  }

  async open(path: string): Promise<void> {
    await this.page.goto(`${this.server}${path}`, {
      waitUntil: 'domcontentloaded'
    })
  }

  async press(label: string): Promise<void> {
    await this.waited(
      `${label} to press`,
      this.page.waitForFunction(
        pressable,
        { timeout: this.patienceMs, polling: POLL_MS },
        label
      )
    )
    await this.page.evaluate(
      (wanted: string, find: string) => {
        // eslint-disable-next-line no-new-func
        const found = new Function('wanted', `return (${find})(wanted, true)`)(
          wanted
        ) as HTMLElement
        found.click()
      },
      label,
      FIND_CONTROL
    )
  }

  async fill(label: string, value: string): Promise<void> {
    const selector = `:is(input, textarea)[aria-label="${label}"]`
    await this.waited(
      `${label} to fill`,
      this.page.waitForSelector(selector, {
        timeout: this.patienceMs,
        visible: true
      })
    )
    await this.page.$eval(selector, node => {
      ;(node as HTMLInputElement).select()
    })
    await this.page.keyboard.press('Backspace')
    await this.page.type(selector, value)
  }

  async has(label: string): Promise<boolean> {
    return await this.page.evaluate(present, label)
  }

  async text(): Promise<string> {
    return await this.page.evaluate(() => document.body.innerText)
  }

  async waitForText(words: string, ms = this.patienceMs): Promise<void> {
    await this.waited(
      `the words "${words}"`,
      this.page.waitForFunction(
        (wanted: string) =>
          document.body.innerText.toLowerCase().includes(wanted.toLowerCase()),
        { timeout: ms, polling: POLL_MS },
        words
      )
    )
  }

  async waitForLabel(label: string, ms = this.patienceMs): Promise<void> {
    await this.waited(
      label,
      this.page.waitForFunction(
        present,
        { timeout: ms, polling: POLL_MS },
        label
      )
    )
  }

  async api(method: string, path: string, body?: unknown): Promise<Answer> {
    return await this.page.evaluate(
      async (verb: string, url: string, payload: string | null) => {
        const response = await fetch(url, {
          method: verb,
          credentials: 'include',
          headers:
            payload == null ? {} : { 'content-type': 'application/json' },
          body: payload === null ? undefined : payload
        })
        const text = await response.text()
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          // Anything else is reported as it came.
        }
        return { status: response.status, body: parsed }
      },
      method,
      `/api/v1${path}`,
      body === undefined ? null : JSON.stringify(body)
    )
  }

  frames(): unknown[] {
    return this.seen
  }

  async videoPlayback(ms = this.patienceMs): Promise<Playback> {
    const end = Date.now() + ms
    let first = -1
    while (Date.now() < end) {
      const look = await this.page.evaluate(() => {
        const video = document.querySelector('video')
        return {
          at: video === null ? -1 : video.currentTime,
          refused: document.body.innerText.includes("can't play")
        }
      })
      if (look.refused) return 'undecodable'
      if (first < 0) first = look.at
      else if (look.at > first) return 'plays'
      await new Promise(done => {
        setTimeout(done, 500)
      })
    }
    return 'stalled'
  }

  async close(): Promise<void> {
    await this.page.close()
  }
}

/** Each person a browser profile of their own, as one device is. */
export class BrowserDriver implements Driver {
  private readonly browsers: Browser[] = []

  constructor(private readonly patienceMs: number) {}

  async signIn(account: BrowserAccount, server: string): Promise<Surface> {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        // The scoring screen's field is 3D, and a box has no graphics card.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
    this.browsers.push(browser)
    const page = await browser.newPage()
    page.setDefaultTimeout(this.patienceMs)
    await page.setViewport({ width: 1200, height: 900 })
    const surface = new BrowserSurface(page, server, this.patienceMs)
    await surface.listen()
    await surface.open('/sign-in')
    await surface.waitForText('Sign in', this.patienceMs)
    await surface.fill('E-mail address', account.email)
    await surface.press('Use a password instead')
    await surface.fill('Password', account.password)
    await page.keyboard.press('Enter')
    await surface.waitForLabel('Account,*', this.patienceMs)
    return surface
  }

  async close(): Promise<void> {
    await Promise.all(this.browsers.map(async browser => await browser.close()))
  }
}

export interface FunctionalIo {
  log: (line: string) => void
  driver?: Driver
  run?: RunCommand
}

const OPTIONS = {
  server: { type: 'string', multiple: true },
  credentials: { type: 'string' },
  'publish-command': { type: 'string' },
  'restart-command': { type: 'string' },
  'valkey-block-command': { type: 'string' },
  report: { type: 'string' },
  only: { type: 'string', multiple: true },
  'patience-seconds': { type: 'string' }
} as const

/** Runs the actions, answering the process's exit code. */
export async function runFunctional(
  argv: string[],
  io: FunctionalIo,
  actions = ACTIONS
): Promise<number> {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true })
  const servers = (values.server ?? []).map(url => url.replace(/\/+$/, ''))
  if (servers.length === 0) throw new Error('--server is required')
  if (values.credentials == null) throw new Error('--credentials is required')
  const credentials = readCredentials(values.credentials)
  const patienceMs = Number(values['patience-seconds'] ?? 60) * 1000
  const chosen =
    values.only == null
      ? actions
      : actions.filter(action => values.only?.includes(action.name))
  const driver = io.driver ?? new BrowserDriver(patienceMs)
  const context: Context = {
    servers,
    credentials,
    driver,
    tabs: new Map(),
    publishCommand: values['publish-command'],
    restartCommand: values['restart-command'],
    valkeyBlockCommand: values['valkey-block-command'],
    run: io.run ?? runCommand,
    pollMs: 500,
    patienceMs,
    pitches: 0
  }
  try {
    const lines: string[] = []
    const results = await runActions(chosen, context, line => {
      lines.push(line)
      io.log(line)
    })
    const summary = renderSummary(results)
    io.log(summary)
    if (values.report != null)
      writeFileSync(values.report, `${[...lines, summary].join('\n')}\n`)
    return results.some(row => row.status === 'failed') ? 1 : 0
  } finally {
    await driver.close()
  }
}

/* c8 ignore start */
const entry = process.argv[1] ?? ''
if (entry.endsWith('/dbLoad/functional.ts')) {
  runFunctional(process.argv.slice(2), { log: console.log }).then(
    code => {
      process.exit(code)
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  )
}
/* c8 ignore stop */
