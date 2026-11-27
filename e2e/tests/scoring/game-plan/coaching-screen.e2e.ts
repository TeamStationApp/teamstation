// The functions the page runs are transpiled by sucrase, which turns ?. and
// ?? into helpers the page does not have: they use neither.
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type WebSession
} from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'

/**
 * Coach Game end to end on the web: the coaching screen's tabs, roster bar
 * and Defense field, its game plan, and the scorekeeper's roster sheet and
 * scoring screen that follow the plan, in the runner's browser at an
 * iPhone's 402×874 against the stack, each scenario on its own lineup game
 * (`coach-plan`). One browser per window size; the head coach and the
 * scorekeeper take turns in it, signed in by their session cookie.
 *
 * Everything that acts goes through maestro-d; the page is read. What the
 * page does with hardware a test browser lacks, or with the network a
 * scenario holds or breaks, is a stand-in installed before the page's own
 * script (`INSTRUMENTS`): the share sheet and printer, a download kept in
 * memory, the API's answers to inning downloads (passed, held or failed),
 * every response's status, and the game socket's `plans` frames. A copy or
 * a paste is a clipboard event maestro-d dispatches on the focused grid,
 * carrying what was copied or the text to paste.
 *
 * Folded into the game-plan specs beside this one: P27 (the inning columns
 * grow with the window and the tab stops at 1206 points) is
 * `scoring/game-plan/inning-columns#grow-with-window`; P26's error lines,
 * three doubled cells and Clear's red are
 * `scoring/game-plan/position-errors#missing-and-doubled`; P28's share sheet
 * PDF and print frame are `scoring/game-plan/share-print#share-and-print`.
 * This spec keeps what those do not check.
 */

const WIDTH = 402
const HEIGHT = 874
const PHONE = { width: WIDTH, height: HEIGHT }
const NARROW = { width: 320, height: 568 }
const RED = 'rgb(248, 113, 113)'
/** Box Score, on either version: a tab named `Box`, or the `Box Score` pill. */
const BOX_SCORE = '[aria-label="Box"][role="tab"], [aria-label="Box Score"]'

type PlanCell = string
type Person =
  | 'scorekeeper'
  | 'headCoach'
  | 'assistant'
  | 'awayCoach'
  | 'member'
  | 'teamAdmin'

interface Player {
  userId: string
  gumboId: number
  name: string
  jersey: string
}

/** The world's lineup game, as `lineup-fixture` printed it. */
interface Lineup {
  gameId: string
  seasonId: string
  teams: Record<'home' | 'away', string>
  players: Record<'home' | 'away', Player[]>
  accounts: Record<string, { email: string; password: string }>
}

interface GamePlan {
  enabled: boolean
  innings: number
  rows: Array<{
    player: { gumboId: number; fullName: string; jersey: string }
    cells: PlanCell[]
  }>
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Point {
  x: number
  y: number
}
interface FieldCard {
  top: number
  bottom: number
  lines: number
  nameFont: number
}
interface Footer {
  bar: Box
  /** Cancel's word and Save Rosters' word, inside their buttons. */
  cancel: Box
  mic: Box
  save: Box
  cancelInBar: boolean
  /** The two buttons themselves, and Cancel's fill and word colours. */
  cancelButton: Box
  saveButton: Box
  cancelFill: string
  cancelText: string
}

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2
})

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * A Lineup tab card's text, "≡ 1. #1 Ohtani ×", as the Plan tab names the
 * player: "Ohtani #1".
 */
const planName = (lineupCard: string): string => {
  const card = lineupCard
    .replace(/^≡?\s*\d+\.\s*/, '')
    .replace(/×$/, '')
    .trim()
  const numbered = /^#(\d+) (.+)$/.exec(card)
  return numbered == null ? card : `${numbered[2]} #${numbered[1]}`
}
/** A Plan tab row's player without his jersey: "Ohtani #1" is "Ohtani". */
const unnumbered = (row: string): string => row.replace(/ #\d+$/, '')

/** The positions whose cards share a vertical band, top to bottom. */
function cardRows(cards: Record<string, FieldCard>): string[][] {
  const rows: Array<{ bottom: number; positions: string[] }> = []
  for (const [position, card] of Object.entries(cards).sort(
    ([, a], [, b]) => a.top - b.top
  )) {
    const row = rows[rows.length - 1]
    if (row != null && card.top < row.bottom) {
      row.positions.push(position)
      row.bottom = Math.max(row.bottom, card.bottom)
    } else rows.push({ bottom: card.bottom, positions: [position] })
  }
  return rows.map(row => row.positions)
}

/**
 * A plan for the home side's nine in batting order, every inning filled but
 * the sixth's RF: Marte (fifth) sits the fifth and sixth.
 */
const HOME_PLAN: PlanCell[][] = [
  ['P', 'P', 'P', '1B', '1B', 'DH'],
  ['SS', 'SS', 'SS', 'SS', '2B', '2B'],
  ['1B', '1B', '1B', 'P', 'P', 'P'],
  ['CF', 'CF', 'LF', 'LF', 'CF', 'CF'],
  ['RF', 'RF', 'RF', 'RF', '', ''],
  ['2B', '2B', '2B', '2B', 'SS', 'SS'],
  ['3B', '3B', '3B', '3B', '3B', '3B'],
  ['LF', 'LF', 'CF', 'CF', 'LF', 'LF'],
  ['C', 'C', 'C', 'C', 'C', 'C']
]

/** P8's Playing Time Rules, which the Plan tab's capture shows too. */
const P8_RULES = {
  defensivePlayingTime: true,
  measuredIn: 'outs',
  enforceSittingLimits: true
}

/**
 * P10's plan for the home side's nine, in batting order (Ohtani, Lindor,
 * Alonso, Nimmo, Marte, McNeil, Escobar, Canha, Senga), who open at P, C,
 * 1B, 2B, SS, 3B, LF, CF and RF: inning 2 swaps the corners and LF with CF
 * and sits Senga, leaving RF empty; inning 3 swaps them back and puts Senga
 * in RF. The mid-game edit sits Senga in inning 3 as well, a third sit.
 */
const SHIFT_PLAN: PlanCell[][] = [
  ['P', 'P', 'P', 'P', 'P', 'P'],
  ['C', 'C', 'C', 'C', 'C', 'C'],
  ['1B', '3B', '1B', '1B', '1B', '1B'],
  ['2B', '2B', '2B', '2B', '2B', '2B'],
  ['SS', 'SS', 'SS', 'SS', 'SS', 'SS'],
  ['3B', '1B', '3B', '3B', '3B', '3B'],
  ['LF', 'CF', 'LF', 'LF', 'LF', 'LF'],
  ['CF', 'LF', 'CF', 'CF', 'CF', 'CF'],
  ['', '', 'RF', 'RF', 'RF', 'RF']
]
const SHIFT_EDITED: PlanCell[][] = SHIFT_PLAN.map((row, at) =>
  at === 8 ? ['', '', '', 'RF', 'RF', 'RF'] : row
)
/** SHIFT_PLAN with no positions: every cell blank, so the plan is off. */
const NO_POSITIONS: PlanCell[][] = SHIFT_PLAN.map(row =>
  row.map((): PlanCell => '')
)
/**
 * P14's plan: SHIFT_PLAN with its second inning first, so the lineup
 * starts with the corners and LF and CF swapped from the defaults, and
 * Senga sitting, RF empty.
 */
const OPENING_PLAN: PlanCell[][] = SHIFT_PLAN.map(row => [
  row[1],
  ...row.slice(1)
])
/**
 * #299's plan for the home side's nine: inning 1 misses 3B and the outfield
 * and doubles SS; inning 2 holds only two DHs; inning 3 is a whole field;
 * inning 4 has two EHs, which is no duplicate, and misses CF and RF; inning
 * 5 is empty.
 */
const ERROR_PLAN: PlanCell[][] = [
  ['P', 'DH', 'P', 'EH', ''],
  ['C', 'DH', 'C', 'EH', ''],
  ['1B', '', '1B', 'P', ''],
  ['2B', '', '2B', 'C', ''],
  ['SS', '', '3B', '1B', ''],
  ['SS', '', 'SS', '2B', ''],
  ['', '', 'LF', '3B', ''],
  ['', '', 'CF', 'SS', ''],
  ['', '', 'RF', 'LF', '']
]

const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

/**
 * The page's stand-ins, installed before its own script on every document:
 *
 * - `__planShares` and `__planPrints`: a share sheet that keeps the files
 *   it is handed, offered only while `__planCanShare` is true, and a frame
 *   whose print is counted instead of opening the dialog;
 * - `__planDownloads`: each download a link starts, its name and bytes;
 * - `__planInnings`: every inning download asked for, and the home team's
 *   answered as `mode` says (`pass`, `hold` until the client gives up, or
 *   `fail` with a 500), with each GET's status;
 * - `__responses`: every API response's method, path and status, and how
 *   many requests are in flight;
 * - `__planFrames`: the game socket's frames that carry `"plans"`.
 */
const INSTRUMENTS = `
  window.__planShares = [];
  window.__planPrints = { count: 0 };
  window.__planCanShare = false;
  window.__planDownloads = [];
  window.__planInnings = { mode: 'pass', home: '', asked: [], answers: [] };
  window.__responses = { done: [], inFlight: 0 };
  window.__planFrames = [];
  const encode = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    get: () => (window.__planCanShare ? () => true : undefined)
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async data => {
      for (const file of data.files || [])
        window.__planShares.push({
          name: file.name,
          type: file.type,
          title: String(data.title),
          base64: await encode(file)
        });
    }
  });
  const ownClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) {
      const name = this.download;
      fetch(this.href)
        .then(answer => answer.blob())
        .then(encode)
        .then(base64 => window.__planDownloads.push({ name, base64 }));
      return;
    }
    return ownClick.call(this);
  };
  const ownWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() {
      const view = ownWindow.get.call(this);
      if (view == null) return view;
      return new Proxy(view, {
        get: (target, key) =>
          key === 'print' ? () => { window.__planPrints.count++ }
            : key === 'focus' ? () => undefined
            : Reflect.get(target, key)
      });
    }
  });
  const ownFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const path = url.indexOf('/api/v1') < 0 ? url : url.slice(url.indexOf('/api/v1') + 7);
    const innings = window.__planInnings;
    const inning = url.indexOf('/innings/') >= 0;
    if (inning) innings.asked.push(url.slice(url.indexOf('/plans/')));
    const ours = inning && innings.home !== '' && url.indexOf(innings.home) >= 0;
    if (ours && innings.mode === 'hold')
      return new Promise((_, reject) => {
        const signal = init && init.signal;
        if (signal) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    if (ours && innings.mode === 'fail')
      return Promise.resolve(new Response(JSON.stringify({ code: 'internal', message: 'Down' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }));
    window.__responses.inFlight++;
    return ownFetch(input, init).then(
      answer => {
        window.__responses.inFlight--;
        window.__responses.done.push({ method, path, status: answer.status });
        if (inning && method === 'GET')
          innings.answers.push(answer.status + ' ' + url.slice(url.indexOf('/plans/')));
        return answer;
      },
      error => {
        window.__responses.inFlight--;
        throw error;
      }
    );
  };
  const NativeSocket = window.WebSocket;
  class WatchedSocket extends NativeSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener('message', event => {
        const data = String(event.data);
        if (data.indexOf('"plans"') >= 0) window.__planFrames.push(data);
      });
    }
  }
  window.WebSocket = WatchedSocket;
`

/** The world's lineup game, its people and its players. */
async function lineupWorld(ctx: HarnessContext): Promise<Lineup> {
  const world = await ctx.fixture('coach-plan')
  // Loaded here: a spec's import has no side effects.
  const { LINEUP_NAMES } =
    await import('../../../../src/server/dev/lineupFixture')
  const side = (name: 'home' | 'away'): Player[] =>
    LINEUP_NAMES[name].map((player, at) => ({
      userId: world.ids[`${name}${at + 1}User`],
      gumboId: Number(world.ids[`${name}${at + 1}Gumbo`]),
      name: player,
      jersey: String(at + 1)
    }))
  return {
    gameId: world.ids.game,
    seasonId: world.ids.season,
    teams: { home: world.ids.homeTeam, away: world.ids.awayTeam },
    players: { home: side('home'), away: side('away') },
    accounts: world.accounts
  }
}

function api(ctx: HarnessContext): string {
  return `${ctx.stack.origin}/api/v1`
}

/** Each person's API session, signed in once: sign-ins are rate limited. */
const tokens = new Map<string, string>()
async function tokenOf(
  ctx: HarnessContext,
  fixture: Lineup,
  who: Person
): Promise<string> {
  const account = fixture.accounts[who]
  let token = tokens.get(account.email)
  if (token == null) {
    const { signInTestAccount } =
      await import('../../../../src/test/passwordFixtures')
    token = await signInTestAccount(api(ctx), account)
    tokens.set(account.email, token)
  }
  return token
}

/** A request to the stack's API as `who`, its status and JSON body. */
async function call(
  ctx: HarnessContext,
  fixture: Lineup,
  who: Person,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; text: string }> {
  const answer = await fetch(`${api(ctx)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await tokenOf(ctx, fixture, who)}`,
      ...(body == null ? {} : { 'content-type': 'application/json' })
    },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  })
  const text = await answer.text()
  let read: unknown = null
  try {
    read = JSON.parse(text)
  } catch {
    read = null
  }
  return { status: answer.status, body: read, text }
}

/** Saves the home side's game plan as its head coach does. */
async function savePlan(
  ctx: HarnessContext,
  fixture: Lineup,
  cells: PlanCell[][],
  enabled = true
): Promise<void> {
  const plan: GamePlan = {
    enabled,
    innings: cells[0].length,
    rows: cells.map((row, at) => {
      const player = fixture.players.home[at]
      return {
        player: {
          gumboId: player.gumboId,
          fullName: player.name,
          jersey: player.jersey
        },
        cells: row
      }
    })
  }
  const answer = await call(
    ctx,
    fixture,
    'headCoach',
    'PUT',
    `/games/${fixture.gameId}/plans/${fixture.teams.home}`,
    plan
  )
  expect(answer.status, answer.text).equals(200)
}

/** The home side's plan as the API keeps it. */
async function storedPlan(
  ctx: HarnessContext,
  fixture: Lineup
): Promise<GamePlan | null> {
  const read = await call(
    ctx,
    fixture,
    'headCoach',
    'GET',
    `/games/${fixture.gameId}/plans`
  )
  return (read.body as { home: { plan: GamePlan | null } | null }).home
    ?.plan as GamePlan | null
}

/** The home team's own Playing Time Rules, written where the API keeps them. */
async function teamRules(
  ctx: HarnessContext,
  fixture: Lineup,
  rules: Record<string, unknown>
): Promise<void> {
  const { asPlayingTimeRules } =
    await import('../../../../src/common/playingTimeRules')
  await stackSql(
    ctx,
    'update teams set playing_time_rules = $1::jsonb where id = $2',
    [JSON.stringify(asPlayingTimeRules(rules)), fixture.teams.home]
  )
}

/** Moves the game's start time an hour either side of now. */
async function startGame(
  ctx: HarnessContext,
  fixture: Lineup,
  started: boolean
): Promise<void> {
  await stackSql(
    ctx,
    `update games set start_at = now() + ($1::int * interval '1 hour') where id = $2`,
    [started ? -1 : 1, fixture.gameId]
  )
}

/** Who a plan's column puts at each position, by gumboId; null for none. */
function columnDefense(
  fixture: Lineup,
  cells: PlanCell[][],
  inning: number
): Record<string, number | null> {
  const defense: Record<string, number | null> = Object.fromEntries(
    POSITIONS.map(position => [position, null])
  )
  cells.forEach((row, at) => {
    const cell = row[inning - 1]
    if (cell in defense) defense[cell] = fixture.players.home[at].gumboId
  })
  return defense
}

/** The home side's defence as the game's lineups hold it, by gumboId. */
async function homeDefense(
  ctx: HarnessContext,
  fixture: Lineup
): Promise<Record<string, number | null>> {
  const answer = await call(
    ctx,
    fixture,
    'scorekeeper',
    'GET',
    `/games/${fixture.gameId}/lineups`
  )
  expect(answer.status).equals(200)
  const { home } = answer.body as {
    home: {
      current: {
        defense: Record<string, { gumboId: number | null } | null>
      } | null
    }
  }
  return Object.fromEntries(
    POSITIONS.map(position => [
      position,
      home.current?.defense[position]?.gumboId ?? null
    ])
  )
}

/** A defence by gumboId, as names, for the log. */
function named(
  fixture: Lineup,
  defense: Record<string, number | null>
): string {
  return POSITIONS.map(position => {
    const player = fixture.players.home.find(
      each => each.gumboId === defense[position]
    )
    return `${position} ${player?.name ?? '—'}`
  }).join(', ')
}

/** Waits for the game as stored to have reached `inning`'s first pitch. */
async function storedInning(
  ctx: HarnessContext,
  fixture: Lineup,
  inning: number
): Promise<void> {
  const deadline = Date.now() + 30000
  for (;;) {
    const read = (
      await call(
        ctx,
        fixture,
        'scorekeeper',
        'GET',
        `/games/${fixture.gameId}/events`
      )
    ).body as { currentPlay: { about: { inning: number } } | null }
    if ((read.currentPlay?.about.inning ?? 0) >= inning) return
    if (Date.now() > deadline)
      throw new Error(`The game was never saved into inning ${inning}`)
    await sleep(500)
  }
}

/**
 * Waits for the game as stored to hold `expected` as the home defence: an
 * inning's column is downloaded and saved behind the screen.
 */
async function defenseBecomes(
  ctx: HarnessContext,
  fixture: Lineup,
  expected: Record<string, number | null>
): Promise<Record<string, number | null>> {
  const deadline = Date.now() + 20000
  let held = await homeDefense(ctx, fixture)
  while (
    JSON.stringify(held) !== JSON.stringify(expected) &&
    Date.now() < deadline
  ) {
    await sleep(500)
    held = await homeDefense(ctx, fixture)
  }
  return held
}

interface LineupPerson {
  gumboId: number | null
}

/**
 * Posts the home side's lineup as the scorekeeper's hand edit, from what
 * the game holds, changed by `change`.
 */
async function postHomeLineup(
  ctx: HarnessContext,
  fixture: Lineup,
  change: (order: number[], defense: Record<string, number>) => void
): Promise<void> {
  const read = (
    await call(
      ctx,
      fixture,
      'scorekeeper',
      'GET',
      `/games/${fixture.gameId}/lineups`
    )
  ).body as {
    digest: string
    home: {
      current: {
        batters: LineupPerson[]
        defense: Record<string, LineupPerson | null>
      } | null
    }
  }
  const held = read.home.current!
  // Every player on the roster, the bench too, as the lineup names them.
  const players = fixture.players.home.map(player => ({
    gumboId: player.gumboId,
    fullName: player.name,
    jersey: player.jersey
  }))
  const at = (person: LineupPerson): number =>
    players.findIndex(player => player.gumboId === person.gumboId)
  const order = held.batters.map(at)
  const defense: Record<string, number> = Object.fromEntries(
    Object.entries(held.defense).flatMap(([position, person]) =>
      person == null ? [] : [[position, at(person)]]
    )
  )
  change(order, defense)
  const posted = await call(
    ctx,
    fixture,
    'scorekeeper',
    'POST',
    `/games/${fixture.gameId}/lineups`,
    { side: 'home', base: read.digest, players, battingOrder: order, defense }
  )
  expect(posted.status, posted.text).equals(200)
}

/** Swaps two home fielders through the API, as a scorekeeper's hand edit. */
async function handSwap(
  ctx: HarnessContext,
  fixture: Lineup,
  a: string,
  b: string
): Promise<void> {
  await postHomeLineup(ctx, fixture, (_order, defense) => {
    ;[defense[a], defense[b]] = [defense[b], defense[a]]
  })
}

/** maestro-d's name for a key the page is sent. */
function keyName(key: string): string {
  const named: Record<string, string> = {
    ArrowRight: 'right',
    ArrowLeft: 'left',
    ArrowUp: 'up',
    ArrowDown: 'down',
    Backspace: 'backspace',
    Escape: 'escape',
    Enter: 'enter',
    Tab: 'tab'
  }
  return named[key] ?? key
}

/** One browser window, and what the scenarios do in it. */
class Web {
  constructor(
    readonly ctx: HarnessContext,
    readonly session: WebSession,
    readonly fixture: Lineup,
    readonly size: { width: number; height: number }
  ) {}

  get m(): any {
    return this.session.m
  }

  get page(): WebSession['page'] {
    return this.session.page
  }

  /** Signs this browser in as one of the world's people, by his cookie. */
  async as(who: Person): Promise<void> {
    await this.m.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(await tokenOf(this.ctx, this.fixture, who)),
          domain: new URL(this.ctx.stack.origin).hostname,
          path: '/'
        }
      ]
    })
  }

  async go(path: string): Promise<void> {
    await this.m.openLink({ link: `${this.ctx.stack.origin}${path}` })
  }

  async tapCss(css: string): Promise<void> {
    await this.page.waitForSelector(css, { visible: true })
    await this.m.tapOn({ css, timeout: 15000 })
  }

  async tap(label: string, role?: string): Promise<void> {
    await this.tapCss(
      role == null
        ? `[aria-label="${label}"]`
        : `[aria-label="${label}"][role="${role}"]`
    )
  }

  /** A click on an element, which on a cell highlights it. */
  async click(css: string): Promise<void> {
    await this.page.waitForSelector(css, { visible: true })
    await this.m.tapOn({ css, timeout: 15000 })
    await sleep(150)
  }

  /** A click at a point of the page. */
  async clickAt(point: Point): Promise<void> {
    await this.m.tapOnPoint({
      x: Math.round(point.x),
      y: Math.round(point.y)
    })
  }

  /** A sheet's button by its word, tapped where it is drawn. */
  async tapButtonIn(sheet: string, word: string): Promise<void> {
    const box = await this.page.evaluate(
      (selector: string, text: string) => {
        const node = Array.from(
          document.querySelectorAll(`${selector} [role="button"]`)
        ).find(each => each.textContent === text)
        if (node == null) return null
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      },
      sheet,
      word
    )
    if (box == null) throw new Error(`${sheet} has no ${word}`)
    await this.clickAt(centre(box))
  }

  /** A key typed (one character) or pressed (a named key). */
  async key(key: string): Promise<void> {
    if (key.length === 1) await this.m.inputText({ text: key })
    else await this.m.pressKey({ key: keyName(key) })
  }

  /**
   * A clipboard shortcut on the focused grid: maestro-d dispatches the
   * copy or paste event, carrying `text` for a paste, and what the page
   * copied is read back from it.
   */
  async clipboard(command: 'copy' | 'paste', text = ''): Promise<string> {
    await this.m.evalBrowserScript({
      script: `
        const data = new DataTransfer();
        if (${JSON.stringify(command)} === 'paste') data.setData('text/plain', ${JSON.stringify(text)});
        const target = document.activeElement || document.body;
        target.dispatchEvent(new ClipboardEvent(${JSON.stringify(command)}, { clipboardData: data, bubbles: true, cancelable: true }));
        window.__planCopied = data.getData('text/plain') || data.getData('text');
        return window.__planCopied;
      `
    })
    await sleep(200)
    return String(await this.page.evaluate(() => (window as any).__planCopied))
  }

  /**
   * A drag from one point to another, held still `hold` milliseconds
   * first, and released after the drop's hover settles.
   */
  async drag(from: Point, to: Point, hold = 0): Promise<void> {
    await this.m.dragAndDrop({
      from: { point: `${Math.round(from.x)},${Math.round(from.y)}` },
      to: { point: `${Math.round(to.x)},${Math.round(to.y)}` },
      holdDuration: Math.max(hold, 1),
      duration: 300
    })
    await sleep(400)
  }

  /** Coach Game, opened from the game's `Coach` pill. */
  async coachGame(): Promise<void> {
    await this.go(`/games/${this.fixture.gameId}`)
    await this.page.waitForSelector('[aria-label="Game sections"]', {
      timeout: 60000
    })
    await this.tap('Coach')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 60000
    })
  }

  /** The scoring screen for this game, its help dismissed. */
  async scoreGame(): Promise<void> {
    await this.go(`/games/${this.fixture.gameId}/score`)
    await this.page.waitForSelector('[aria-label="Open scoring menu"]', {
      timeout: 60000
    })
    for (const label of ['OK', 'Close'])
      if ((await this.page.$(`[aria-label="${label}"]`)) != null)
        await this.tap(label)
  }

  /** The scorekeeper's Set Team Rosters sheet, on the home team. */
  async scorekeeperRosters(): Promise<void> {
    await this.tap('Open scoring menu')
    await this.tap('Set Team Rosters')
    await this.page.waitForSelector('[aria-label="Save Rosters"]', {
      timeout: 30000
    })
    if ((await this.page.$('[aria-label="Home Team"][role="tab"]')) != null)
      await this.tap('Home Team', 'tab')
  }

  /** The scoring menu's End Half Inning, confirmed. */
  async endHalf(): Promise<void> {
    const half = await this.page.$eval('[aria-label="Open scoring menu"]', () =>
      String(document.body.textContent)
    )
    await this.tap('Open scoring menu')
    await this.tap('End Half Inning')
    await this.tap('Confirm End Half Inning')
    await this.page.waitForFunction(
      (before: string) => String(document.body.textContent) !== before,
      { timeout: 15000 },
      half
    )
    await sleep(500)
  }

  /** One ball to the batter up, once the screen takes it. */
  async ball(): Promise<void> {
    await this.tap('Ball')
    await sleep(500)
  }

  /** Whether the scoring screen draws the plan notice it no longer has. */
  async planNotice(): Promise<boolean> {
    return (await this.page.$('[data-testid="scoringPlanNotice"]')) != null
  }

  /** The card the scoring screen drops when an inning's column fails. */
  async syncNotice(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const node = document.querySelector('[data-testid="planSyncNotice"]')
      return node == null ? null : String(node.textContent)
    })
  }

  /** The Defense tab chosen and its field drawn, every card in place. */
  async defense(): Promise<void> {
    await this.tap('Defense', 'tab')
    await this.page.waitForSelector(
      '[aria-label="Defense"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    await this.page.waitForSelector('[data-testid="Defensive field"]', {
      visible: true,
      timeout: 15000
    })
    await this.page.waitForSelector('[data-roster-target="defense-CF"]', {
      visible: true,
      timeout: 15000
    })
  }

  /** A Help pressed, and its sheet up. */
  async helpSheet(label = 'Defense help'): Promise<string> {
    await this.tap(label)
    const text = await this.page.waitForSelector(
      '[data-testid="Help sheet text"]',
      { visible: true, timeout: 15000 }
    )
    await this.m.waitForAnimationToEnd()
    return await text!.evaluate(node => String(node.textContent))
  }

  /** The help sheet closed by a tap on the backdrop above it. */
  async closeHelpSheet(): Promise<void> {
    const sheet = await this.box('[data-testid="Scoring sheet"]')
    await this.clickAt({ x: this.size.width / 2, y: sheet.y / 2 })
    await this.page.waitForSelector('[data-testid="Help sheet text"]', {
      hidden: true,
      timeout: 15000
    })
  }

  /** An element's box, as the page lays it out. */
  async box(css: string): Promise<Box> {
    return await this.page.$eval(css, node => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }

  /**
   * The Defense tab's layout: Help and Clear, the position cards, the
   * roster cards, the footer bar's edges, and whether the old instruction
   * line and Roster header are drawn.
   */
  async defenseLayout(): Promise<{
    field: Box
    help: Box
    clear: Box
    cards: Box[]
    roster: Box[]
    bar: Box
    instruction: boolean
    header: boolean
  }> {
    return await this.page.evaluate(() => {
      const box = (node: Element): Box => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const field = document.querySelector('[data-testid="Defensive field"]')!
      return {
        field: box(field),
        help: box(document.querySelector('[aria-label="Defense help"]')!),
        clear: box(document.querySelector('[aria-label="Clear Defense"]')!),
        cards: Array.from(
          field.querySelectorAll(
            '[data-testid^="Defense "][data-testid$=" card"]'
          )
        ).map(box),
        roster: Array.from(
          document.querySelectorAll(
            '[data-testid="Defense roster grid"] [data-roster-player]'
          )
        ).map(box),
        bar: box(document.querySelector('[data-testid="Roster footer bar"]')!),
        instruction: String(document.body.textContent).includes(
          'Drag a player into position'
        ),
        header:
          document.querySelector('[data-testid="Defense roster header"]') !=
          null
      }
    })
  }

  /** Each position card's vertical extent and its name's font size. */
  async fieldCards(): Promise<Record<string, FieldCard>> {
    return await this.page.$$eval('[data-testid^="Defense "]', nodes => {
      const cards: Record<string, FieldCard> = {}
      for (const node of nodes) {
        const match = /^Defense (\S+) card$/.exec(
          String(node.getAttribute('data-testid'))
        )
        if (match == null) continue
        const box = node.getBoundingClientRect()
        const lines = node.querySelectorAll('[dir="auto"]')
        const name = lines[lines.length - 1]
        cards[match[1]] = {
          top: box.top,
          bottom: box.bottom,
          lines: lines.length,
          nameFont: parseFloat(window.getComputedStyle(name).fontSize)
        }
      }
      return cards
    })
  }

  /** Where the roster footer bar draws Cancel, the microphone and Save. */
  async footer(): Promise<Footer> {
    await this.page.waitForSelector('[data-testid="Roster mic"]', {
      visible: true,
      timeout: 15000
    })
    // The scorekeeper's sheet slides up as it opens: read once it is still.
    let last = ''
    for (let read = 0; read < 20; read++) {
      const now = await this.page.$eval(
        '[data-testid="Roster footer bar"]',
        node => String(node.getBoundingClientRect().bottom)
      )
      if (now === last) break
      last = now
      await sleep(250)
    }
    return await this.page.evaluate(() => {
      const box = (node: Element): Box => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const word = (node: Element): Box => {
        const label = node.querySelector('[dir="auto"]')
        // No `??` here: the page has no sucrase helpers.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        return box(label == null ? node : label)
      }
      const bar = document.querySelector('[data-testid="Roster footer bar"]')!
      const cancel = document.querySelector('[data-testid="Roster cancel"]')!
      const save = bar.querySelector('[aria-label="Save Rosters"]')!
      const label = cancel.querySelector('[dir="auto"]')
      return {
        bar: box(bar),
        cancel: word(cancel),
        mic: box(bar.querySelector('[data-testid="Roster mic"]')!),
        save: word(save),
        cancelInBar: bar.contains(cancel),
        cancelButton: box(cancel),
        saveButton: box(save),
        cancelFill: getComputedStyle(cancel).backgroundColor,
        // No `?.` here: the page has no sucrase helpers.
        cancelText: label == null ? '' : getComputedStyle(label).color
      }
    })
  }

  /** The Plan tab chosen and its sheet drawn. */
  async plan(): Promise<void> {
    await this.tap('Plan', 'tab')
    await this.page.waitForSelector(
      '[aria-label="Plan"][role="tab"][aria-selected="true"]',
      { timeout: 15000 }
    )
    await this.page.waitForSelector('[data-testid="Plan cell 1-1"]', {
      visible: true,
      timeout: 15000
    })
  }

  /** A cell's text as the sheet shows it. */
  async cell(row: number, inning: number): Promise<string> {
    return await this.page.$eval(
      `[data-testid="Plan cell ${row}-${inning}"]`,
      node => String(node.textContent)
    )
  }

  /**
   * Where the web's keys go: the focused element, whether any text field is
   * drawn on the Plan tab or any text selected, and the highlighted cell.
   */
  async planFocus(): Promise<{
    focused: string
    inputs: number
    selection: string
    lit: string[]
  }> {
    return await this.page.evaluate(() => {
      const active = document.activeElement
      return {
        focused:
          active == null
            ? ''
            : `${active.tagName} ${String(active.getAttribute('data-testid'))}`,
        inputs: document.querySelectorAll('[data-testid="Plan tab"] input')
          .length,
        selection: String(window.getSelection()),
        lit: Array.from(
          document.querySelectorAll(
            '[data-testid^="Plan cell "][aria-selected="true"]'
          )
        ).map(node => String(node.getAttribute('data-testid')))
      }
    })
  }

  /** Every row's cells, top to bottom, as the sheet shows them. */
  async cells(): Promise<string[][]> {
    return await this.page.evaluate(() => {
      const rows: string[][] = []
      for (const node of document.querySelectorAll(
        '[data-testid^="Plan cell "]'
      )) {
        const match = /^Plan cell (\d+)-(\d+)$/.exec(
          String(node.getAttribute('data-testid'))
        )
        if (match == null) continue
        const row = Number(match[1]) - 1
        while (rows.length <= row) rows.push([])
        rows[row][Number(match[2]) - 1] = String(node.textContent)
      }
      return rows
    })
  }

  /** The players down the sheet's left column. */
  async planPlayers(): Promise<string[]> {
    return await this.page.$$eval('[data-testid^="Plan player "]', nodes =>
      nodes.map(node => String(node.textContent))
    )
  }

  /** The Lineup tab's cards, in batting order. */
  async lineupCards(): Promise<string[]> {
    return await this.page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes => nodes.map(node => String(node.textContent))
    )
  }

  /** The warnings shown, as `<level> <rule>: <text>`, reds first. */
  async warnings(): Promise<string[]> {
    return await this.page.$$eval('[data-testid^="Plan warning "]', nodes =>
      nodes.map(node => {
        const id = String(node.getAttribute('data-testid'))
        return `${id.slice('Plan warning '.length)}: ${String(node.textContent)}`
      })
    )
  }

  /** The window as it is, once it has settled, kept in the run directory. */
  async shot(name: string): Promise<void> {
    await this.m.waitForAnimationToEnd()
    await this.m.takeScreenshot({ path: this.ctx.artifact(name) })
  }

  /**
   * The whole of a screen that scrolls, in one frame: the window, as wide as
   * ever, is made as tall as `scroller`'s content needs for the shot, then
   * put back.
   */
  async tallShot(name: string, scroller: string): Promise<void> {
    let height = this.size.height
    try {
      for (let pass = 0; pass < 3; pass++) {
        const extra = await this.page.$eval(scroller, node => {
          node.scrollTop = 0
          return node.scrollHeight - node.clientHeight
        })
        if (extra <= 0) break
        height += extra
        await this.session.resize({ width: this.size.width, height })
        await sleep(600)
      }
      await this.shot(name)
    } finally {
      await this.session.resize(this.size)
      await sleep(600)
    }
  }

  /** Drags the plan's row `from` (1-based) above row `to`, by the name. */
  async dragRow(from: number, to: number): Promise<void> {
    const start = await this.box(`[data-testid="Plan player ${from}"]`)
    const end = await this.box(`[data-testid="Plan player ${to}"]`)
    await this.drag(
      { x: start.x + 40, y: start.y + start.height / 2 },
      { x: start.x + 40, y: end.y + 6 }
    )
  }

  /** The scroller scrolled back to its top. */
  async scrollTop(css: string): Promise<void> {
    await this.m.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(css)}).scrollTop = 0`
    })
    await sleep(200)
  }

  /** Brings `css` into view at the foot of the window. */
  async scrollToElement(css: string): Promise<void> {
    await this.m.evalBrowserScript({
      script: `document.querySelector(${JSON.stringify(css)}).scrollIntoView({ block: 'end' })`
    })
    await this.m.waitForAnimationToEnd()
  }
}

/** Cancel in the bar, left of the microphone, level with Save Rosters. */
function expectFooterRow(footer: Footer, height = HEIGHT): void {
  const { bar, cancel, mic, save } = footer
  expect(footer.cancelInBar).equals(true)
  // Cancel is a red button with a white word, Save Rosters' size.
  expect(footer.cancelFill).equals('rgb(168, 53, 53)')
  expect(footer.cancelText).equals('rgb(255, 255, 255)')
  expect(footer.cancelButton.width).closeTo(footer.saveButton.width, 1)
  expect(footer.cancelButton.height).closeTo(footer.saveButton.height, 1)
  expect(footer.cancelButton.x + footer.cancelButton.width).lessThan(mic.x)
  expect(cancel.x + cancel.width).lessThan(mic.x)
  expect(mic.x + mic.width).lessThan(save.x + 1)
  expect(Math.abs(cancel.y - save.y)).lessThan(4)
  for (const each of [cancel, mic, save]) {
    expect(each.y).at.least(bar.y - 0.5)
    expect(each.y + each.height).at.most(bar.y + bar.height + 0.5)
  }
  expect(bar.y + bar.height).at.most(height)
}

/** A browser of `size` on the world's lineup game, its stand-ins in. */
async function open(
  ctx: HarnessContext,
  fixture: Lineup,
  size = PHONE
): Promise<Web> {
  const session = await ctx.browser(size, { beforeLoad: INSTRUMENTS })
  session.page.setDefaultTimeout(30000)
  return new Web(ctx, session, fixture, size)
}

/** The world, and the phone-sized browser on it. */
async function setUp(
  ctx: HarnessContext
): Promise<{ fixture: Lineup; coach: Web }> {
  const fixture = await lineupWorld(ctx)
  return { fixture, coach: await open(ctx, fixture) }
}

/** Lines a scenario keeps beside its result, as the old run printed them. */
function log(ctx: HarnessContext, name: string, lines: string[]): void {
  writeFileSync(ctx.artifact(name), lines.join('\n') + '\n')
}

/** Cancel and Save Rosters fit on one row, labels uncut, at `size`. */
async function fits(web: Web, where: string, lines: string[]): Promise<void> {
  const { width, height } = web.size
  const footer = await web.footer()
  expectFooterRow(footer, height)
  for (const each of [footer.bar, footer.cancel, footer.mic, footer.save]) {
    expect(each.x, where).at.least(0)
    expect(each.x + each.width, where).at.most(width)
  }
  const labels = await web.page.evaluate(() =>
    ['[data-testid="Roster cancel"]', '[aria-label="Save Rosters"]'].map(
      css => {
        const label = document
          .querySelector(css)!
          .querySelector<HTMLElement>('[dir="auto"]')!
        return {
          text: String(label.textContent),
          scroll: label.scrollWidth,
          client: label.clientWidth,
          size: getComputedStyle(label).fontSize
        }
      }
    )
  )
  lines.push(`${where} at ${width} wide: ${JSON.stringify(labels)}`)
  for (const label of labels)
    expect(label.scroll, `${where}: ${label.text}`).at.most(label.client)
  // Cancel is drawn at Save Rosters' size, not left larger.
  expect(labels[0].size, `${where}: Cancel's size`).equals(labels[1].size)
}

const ROSTER_CHAT_FIXTURE =
  "needs the roster chat overlay fixture page (src/test/rosterChatOverlay.fixture.tsx, bundled beside the web build), which no stack serves: a stack serves only the ref's own web app"

export default defineHarness({
  id: 'scoring/game-plan/coaching-screen',
  title:
    "Coach Game's tabs, roster bar, Defense field and game plan, and the scorekeeper's screens that follow the plan, on the web",
  kind: 'e2e',
  covers: [
    'src/app/screens/CoachGameScreen.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/DefensiveField.tsx',
    'src/app/scoring/PlanSyncNotice.tsx',
    'src/app/scoring/plan/**',
    'src/common/gamePlan.ts',
    'src/common/playingTimeRules.ts',
    'src/server/routes/gamePlans.ts',
    'src/server/routes/lineups.ts'
  ],
  stack: 'isolated',
  fixtures: ['coach-plan'],
  exclusive: false,
  surfaces: {
    // The plan and the scoring screen are drawn by the scoring screens,
    // which only a GPU draws: the Mac's browser.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 60,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'captures-box-score-and-defense': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tapCss(BOX_SCORE)
      await coach.page.waitForFunction(
        () => {
          const box = document.querySelector('[data-testid="Roster box score"]')
          return (
            box != null &&
            String(box.textContent).includes('The game has not started')
          )
        },
        { timeout: 30000 }
      )
      await coach.page.waitForSelector('[data-testid="Roster footer bar"]', {
        visible: true
      })
      await coach.shot('coach-box-after.png')
      await coach.defense()
      await coach.shot('defense-coach-after.png')
      if ((await coach.page.$('[aria-label="Defense help"]')) != null) {
        await coach.helpSheet()
        await coach.shot('defense-help-sheet.png')
        await coach.closeHelpSheet()
      }
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await coach.scorekeeperRosters()
      await coach.defense()
      await coach.shot('defense-scorekeeper-after.png')
    },

    'captures-position-errors-and-pills': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, ERROR_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      await coach.tallShot(
        'plan-phone-web-after.png',
        '[data-testid="Plan scroll"]'
      )
      await coach.as('assistant')
      await coach.go(`/games/${fixture.gameId}`)
      await coach.page.waitForSelector('[aria-label="Game sections"]', {
        timeout: 60000
      })
      await coach.page.waitForFunction(
        () => String(document.body.textContent).includes('Hosts'),
        { timeout: 30000 }
      )
      await sleep(500)
      await coach.shot('coach-assistant-after.png')
    },

    'captures-plan-and-picker': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await teamRules(ctx, fixture, P8_RULES)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      await coach.tapCss('[data-testid="Plan add inning"]')
      await coach.page.waitForSelector('[data-testid="Plan inning 7"]')
      await coach.tallShot('plan-tab-after.png', '[data-testid="Plan scroll"]')
      await coach.click('[data-testid="Plan cell 1-1"]')
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      await coach.shot('plan-picker-after.png')
      await coach.key('Escape')
      await coach.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Plan field picker"]') == null
      )
      await coach.helpSheet('Plan help')
      await coach.shot('plan-help-sheet.png')
      await coach.closeHelpSheet()
      await coach.tapCss('[data-testid="Plan inning 7"]')
      await coach.page.waitForSelector('[aria-label="Delete inning 7?"]', {
        visible: true
      })
      await coach.shot('plan-delete-inning.png')
    },

    'captures-roster-chat': async () => {
      throw new BlockedError(ROSTER_CHAT_FIXTURE)
    },

    'd1-field-corners-and-roster-width': async ctx => {
      const { coach } = await setUp(ctx)
      const lines: string[] = []
      /** The Defense tab as D1 reads it, for the coach or the scorekeeper. */
      const check = async (
        who: string,
        baseRosterTop: number
      ): Promise<void> => {
        const layout = await coach.defenseLayout()
        lines.push(`D1 ${who}: ${JSON.stringify(layout)}`)
        const { field, help, clear, cards, roster, bar } = layout
        expect(layout.instruction, who).equals(false)
        expect(layout.header, who).equals(false)
        expect(help.x - field.x, who).closeTo(4, 1)
        expect(help.y - field.y, who).closeTo(4, 1)
        expect(field.x + field.width - (clear.x + clear.width), who).closeTo(
          4,
          1
        )
        expect(clear.y - field.y, who).closeTo(4, 1)
        expect(cards).has.length(9)
        for (const control of [help, clear])
          for (const card of cards)
            expect(
              control.x + control.width <= card.x ||
                control.x >= card.x + card.width ||
                control.y + control.height <= card.y ||
                control.y >= card.y + card.height,
              `${who}: a control over a card`
            ).equals(true)
        // The four bench players, two to a row, from margin to margin: the
        // footer bar spans the same content.
        expect(roster).has.length(4)
        const left = Math.min(...roster.map(card => card.x))
        const right = Math.max(...roster.map(card => card.x + card.width))
        expect(left, who).closeTo(bar.x, 1)
        expect(right, who).closeTo(bar.x + bar.width, 1)
        // The list starts at least a row higher than at the base's capture.
        const top = Math.min(...roster.map(card => card.y))
        expect(top, who).lessThan(baseRosterTop - 28)
        expect(await coach.helpSheet()).equals(
          'Tap and drag players into positions.'
        )
        await coach.closeHelpSheet()
        expectFooterRow(await coach.footer())
      }
      try {
        await coach.as('headCoach')
        await coach.coachGame()
        await coach.defense()
        // The base's coach Defense capture drew the first roster card's top
        // at 586 points, the scorekeeper's at 577; its Box Score pill 14
        // points under the header.
        await check('coach', 586)
        const header = await coach.box('[data-testid="Coach header"]')
        const pill = await coach.box('[data-testid="Box Score pill"]')
        const gap = pill.y - (header.y + header.height)
        lines.push(`D1 Box Score gap: ${gap}`)
        expect(gap).closeTo(7, 1)
        await coach.as('scorekeeper')
        await coach.scoreGame()
        await coach.scorekeeperRosters()
        await coach.defense()
        await check('scorekeeper', 577)
      } finally {
        log(ctx, 'defense-layout.log', lines)
      }
    },

    'd2-roster-chat-overlay': async () => {
      throw new BlockedError(ROSTER_CHAT_FIXTURE)
    },

    'd4-bench-player-on-vacated-box': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.defense()
      // 2B cleared by a tap, then SS dragged onto the empty 2B.
      await coach.tap('Clear 2B')
      await coach.page.waitForSelector('[aria-label="Assign 2B"]')
      const shortstop = await coach.box('[data-roster-target="defense-SS"]')
      const second = await coach.box('[data-roster-target="defense-2B"]')
      await coach.drag(centre(shortstop), centre(second))
      await coach.page.waitForSelector('[aria-label="Assign SS"]')
      await coach.page.waitForSelector('[aria-label="Clear 2B"]')
      const vacated = await coach.box('[data-roster-target="defense-SS"]')
      const card = await coach.box('[data-testid="Defense SS card"]')
      expect(vacated.height).closeTo(card.height, 1)
      // A bench player, picked up by his grip, dropped on the box's centre.
      const bench = await coach.page.$eval(
        '[data-testid="Defense roster grid"] [data-roster-player]',
        node => String(node.getAttribute('aria-label'))
      )
      const grip = await coach.box(`[aria-label="Drag ${bench}"]`)
      await coach.drag(centre(grip), centre(card))
      await coach.page.waitForSelector('[aria-label="Clear SS"]')
      const fielder = await coach.page.$eval('[aria-label="Clear SS"]', node =>
        String(node.textContent)
      )
      log(ctx, 'defense-drop.log', [
        `D4 vacated SS: ${JSON.stringify({ vacated, card })}`,
        `D4 SS now: ${fielder} (dropped ${bench})`
      ])
      expect(fielder).includes(bench.replace(/^.* /, ''))
    },

    'p1-box-score-pill-above-tabs': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      const read = async (): Promise<{
        pill: Box & { selected: string | null }
        tabs: Array<Box & { label: string; selected: string | null }>
      }> =>
        await coach.page.evaluate(() => {
          const box = (node: Element): Box => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }
          const pill = document.querySelector('[data-testid="Box Score pill"]')!
          return {
            pill: {
              ...box(pill),
              selected: pill.getAttribute('aria-selected')
            },
            // The roster screen's own tabs: the game's are behind it.
            tabs: [
              ...document
                .querySelector('[aria-label="Roster"][role="tab"]')!
                .parentElement!.querySelectorAll('[role="tab"]')
            ].map(tab => ({
              ...box(tab),
              label: String(tab.getAttribute('aria-label')),
              selected: tab.getAttribute('aria-selected')
            }))
          }
        })
      const opened = await read()
      expect(opened.tabs.map(tab => tab.label)).deep.equals([
        'Roster',
        'Lineup',
        'Defense',
        'Plan'
      ])
      expect(opened.pill.selected).equals('true')
      for (const tab of opened.tabs)
        expect(tab.selected, tab.label).not.equals('true')
      // Its own row: wholly above the three, which share one.
      for (const tab of opened.tabs) {
        expect(opened.pill.y + opened.pill.height).at.most(tab.y + 0.5)
        expect(tab.y).closeTo(opened.tabs[0].y, 0.5)
      }
      await coach.tap('Lineup', 'tab')
      await coach.page.waitForSelector(
        '[aria-label="Lineup"][role="tab"][aria-selected="true"]',
        { timeout: 15000 }
      )
      const lineup = await read()
      expect(lineup.pill.selected).equals('false')
      expect(
        lineup.tabs.filter(tab => tab.selected === 'true').map(tab => tab.label)
      ).deep.equals(['Lineup'])
    },

    'p2-coach-cancel-beside-microphone': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Lineup', 'tab')
      await coach.page.waitForSelector(
        '[aria-label="Lineup"][role="tab"][aria-selected="true"]',
        { timeout: 15000 }
      )
      expectFooterRow(await coach.footer())
    },

    'p3-defense-field-six-rows': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.defense()
      const cards = await coach.fieldCards()
      expect(Object.keys(cards).sort()).deep.equals(
        ['1B', '2B', '3B', 'C', 'CF', 'LF', 'P', 'RF', 'SS'].sort()
      )
      const rows = cardRows(cards)
      expect(Math.max(...rows.map(row => row.length))).lessThan(3)
      expect(rows.map(row => [...row].sort())).deep.equals([
        ['CF'],
        ['LF', 'RF'],
        ['2B', 'SS'],
        ['1B', '3B'],
        ['P'],
        ['C']
      ])
      expect(cards.CF.bottom).lessThan(Math.min(cards.LF.top, cards.RF.top))
      expect(cards.P.top).greaterThan(
        Math.max(cards['3B'].bottom, cards['1B'].bottom)
      )
      // Two lines on a phone-sized Coach screen, the name at 11 × 1.25.
      for (const card of Object.values(cards)) {
        expect(card.lines).equals(2)
        expect(card.nameFont).closeTo(13.75, 0.01)
      }
      // A 320 × 568 screen draws "P · Name" on one line, at its own 12.5
      // points: the short names fit, and nothing shrinks.
      const narrow = await open(ctx, fixture, NARROW)
      await narrow.as('headCoach')
      await narrow.coachGame()
      await narrow.defense()
      await narrow.m.waitForAnimationToEnd()
      const texts = await narrow.page.$$eval(
        '[data-testid^="Defense "][data-testid$=" card"] [dir="auto"]',
        nodes =>
          nodes.map(node => ({
            text: String(node.textContent),
            scroll: node.scrollWidth,
            client: node.clientWidth,
            size: parseFloat(getComputedStyle(node).fontSize)
          }))
      )
      log(ctx, 'defense-320.log', [
        `field at ${NARROW.width} wide: ${JSON.stringify(texts)}`
      ])
      expect(texts).has.length(9)
      for (const each of texts) {
        expect(each.text).match(/^(P|C|1B|2B|3B|SS|LF|CF|RF) · [^#\s]\S*/)
        expect(each.scroll, each.text).at.most(each.client)
        expect(each.size, each.text).equals(12.5)
      }
      await narrow.shot('defense-320-after.png')
    },

    'p4-lineup-order-and-narrow-columns': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Lineup', 'tab')
      const lineup = await coach.lineupCards()
      await coach.plan()
      const players = await coach.planPlayers()
      expect(players).has.length(9)
      // "≡ 1. #1 Ohtani ×" on the Lineup tab is "Ohtani #1" here, in order.
      expect(players).deep.equals(lineup.map(planName))
      for (const player of players) expect(player).match(/^\S.* #\d+$/)
      const columns = await coach.page.evaluate(() => {
        const cell = document.querySelector('[data-testid="Plan cell 1-1"]')!
        // Two characters of the cell's own font.
        const probe = document.createElement('span')
        probe.style.font = getComputedStyle(
          cell.querySelector('[dir="auto"]')!
        ).font
        probe.style.position = 'absolute'
        probe.style.width = '2ch'
        document.body.appendChild(probe)
        const twoCh = probe.getBoundingClientRect().width
        probe.remove()
        const headers = [
          ...document.querySelectorAll('[data-testid^="Plan inning "]')
        ]
        return {
          twoCh,
          headers: headers.map(node => String(node.textContent)),
          widths: [
            ...headers,
            ...[1, 2, 3, 4, 5].map(
              inning =>
                document.querySelector(`[data-testid="Plan cell 1-${inning}"]`)!
                  .parentElement!
            )
          ].map(node => node.getBoundingClientRect().width)
        }
      })
      // A plan opens with five innings.
      expect(columns.headers).deep.equals(['1', '2', '3', '4', '5'])
      expect(columns.twoCh).greaterThan(15)
      for (const width of columns.widths)
        expect(width).at.most(columns.twoCh + 9)
      await coach.tapCss('[data-testid="Plan add inning"]')
      await coach.page.waitForSelector('[data-testid="Plan inning 6"]')
      expect(await coach.cell(9, 6)).equals('')
      const overflow = await coach.page.$eval(
        '[data-testid="Plan innings"]',
        node => ({
          before: node.scrollWidth > node.clientWidth,
          // A drawn scrollbar track takes its height from the content box.
          track: (node as HTMLElement).offsetHeight - node.clientHeight,
          scrollbar: getComputedStyle(node).scrollbarWidth
        })
      )
      expect(overflow.before).equals(true)
      // The innings scroll sideways.
      await coach.m.evalBrowserScript({
        script: `document.querySelector('[data-testid="Plan innings"]').scrollLeft = 60`
      })
      const scrolled = await coach.page.$eval(
        '[data-testid="Plan innings"]',
        node => node.scrollLeft
      )
      expect(scrolled).greaterThan(0)
      expect(overflow.scrollbar).equals('none')
      expect(overflow.track).equals(0)
    },

    'p5-cell-keys-and-refused-paste': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const first = '[data-testid="Plan cell 1-1"]'
      await coach.click(first)
      // Highlighted: the grid holds the focus, no text field is drawn and no
      // text is selected, and the picker opens.
      expect(await coach.planFocus()).deep.equals({
        focused: 'DIV Plan grid',
        inputs: 0,
        selection: '',
        lit: ['Plan cell 1-1']
      })
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      await coach.shot('coach-plan-picker-web.png')
      // C waits for an F, and Enter makes it C.
      await coach.key('c')
      expect(await coach.cell(1, 1)).equals('C')
      expect(await coach.page.$('[data-testid="Plan field picker"]')).equals(
        null
      )
      await coach.key('Enter')
      // X is no position: nothing happens.
      await coach.key('X')
      expect(await coach.cell(1, 1)).equals('C')
      expect(
        await coach.page.$eval(
          '[data-testid="Plan refusal"]',
          node => node.textContent
        )
      ).equals('')
      // S is SS at once.
      await coach.key('s')
      expect(await coach.cell(1, 1)).equals('SS')
      // A paste of SSS, read whole and refused in red, not cut to SS.
      await coach.clipboard('paste', 'SSS')
      expect(
        await coach.page.$eval(
          first,
          node => getComputedStyle(node).borderTopColor
        )
      ).equals(RED)
      expect(await coach.cell(1, 1)).equals('SS')
      expect(
        await coach.page.$eval(
          '[data-testid="Plan refusal"]',
          node => node.textContent
        )
      ).includes('SSS is not a position')
      // Escape closes the picker and keeps the highlight.
      await coach.click('[data-testid="Plan cell 2-1"]')
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      await coach.key('Escape')
      await coach.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Plan field picker"]') == null
      )
      expect((await coach.planFocus()).lit).deep.equals(['Plan cell 2-1'])
      // The bench is blank: Backspace empties a cell.
      await coach.key('p')
      expect(await coach.cell(2, 1)).equals('P')
      await coach.key('Backspace')
      expect(await coach.cell(2, 1)).equals('')
    },

    'p6-picker-click-writes': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      await coach.click('[data-testid="Plan cell 5-3"]')
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      await coach.click('[data-testid="Plan pick CF"]')
      expect(await coach.cell(5, 3)).equals('CF')
      await coach.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Plan field picker"]') == null
      )
    },

    // P6's hover: a pointer over a cell, pressing nothing, changes neither
    // its look nor opens the picker.
    'p6-hover-does-nothing': async () => {
      throw new BlockedError(
        "needs a pointer moved over an element without a press, which maestro-d's web driver has no command for (moveMouse is the computer device's)"
      )
    },

    'p7-row-drag-moves-innings': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const players = await coach.planPlayers()
      const cells = await coach.cells()
      await coach.dragRow(3, 1)
      expect(await coach.planPlayers()).deep.equals([
        players[2],
        players[0],
        players[1],
        ...players.slice(3)
      ])
      expect(await coach.cells()).deep.equals([
        cells[2],
        cells[0],
        cells[1],
        ...cells.slice(3)
      ])
      // The Lineup tab bats him first too.
      await coach.tap('Lineup', 'tab')
      const lineup = await coach.lineupCards()
      expect(planName(lineup[0])).equals(players[2])
      expect(planName(lineup[1])).equals(players[0])
      // Saved with the lineup alone changed: the stored plan's rows follow
      // it, so the next game's Rotate Leadoff reads the new leadoff.
      await coach.tap('Save Rosters')
      const moved = unnumbered(players[2])
      const deadline = Date.now() + 30000
      let stored: GamePlan | null = null
      while (stored?.rows[0]?.player.fullName !== moved) {
        if (Date.now() > deadline)
          throw new Error(
            `The stored plan never led off with ${moved}: ${JSON.stringify(stored?.rows.map(row => row.player.fullName))}`
          )
        await sleep(500)
        stored = await storedPlan(ctx, fixture)
      }
      expect(stored.rows[0].cells).deep.equals(HOME_PLAN[2])
      expect(stored.rows.map(row => row.cells)).deep.equals([
        HOME_PLAN[2],
        HOME_PLAN[0],
        HOME_PLAN[1],
        ...HOME_PLAN.slice(3)
      ])
    },

    'p8-live-warnings-and-save-summary': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await teamRules(ctx, fixture, P8_RULES)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const players = await coach.planPlayers()
      // Marte sits the fifth and sixth: two in a row, and more than one.
      const marte = unnumbered(players[4])
      const senga = unnumbered(players[8])
      const opened = await coach.warnings()
      expect(
        opened.some(line => line.startsWith('red ') && line.includes(marte))
      ).equals(true)
      expect(opened.some(line => line.includes(senga))).equals(false)
      // Senga benched in the first three innings: red at once, before Save.
      for (const inning of [1, 2, 3]) {
        await coach.click(`[data-testid="Plan cell 9-${inning}"]`)
        await coach.key('Backspace')
      }
      const benched = await coach.warnings()
      const consecutive = benched.find(line =>
        line.startsWith('red noConsecutiveSits')
      )!
      expect(consecutive).includes(`${marte}, ${senga}`)
      // Under the sheet, whose Clear is above it.
      const order = await coach.page.evaluate(() => {
        const top = (css: string): number =>
          document.querySelector(css)!.getBoundingClientRect().top
        const sheet = document
          .querySelector('[data-testid="Plan sheet"]')!
          .getBoundingClientRect()
        return [
          top('[data-testid="Plan clear"]') < sheet.top,
          top('[data-testid="Plan warnings"]') >= sheet.bottom
        ]
      })
      expect(order).deep.equals([true, true])
      // Senga dragged to the top: the warnings name him first.
      await coach.scrollTop('[data-testid="Plan scroll"]')
      await coach.dragRow(9, 1)
      expect((await coach.planPlayers())[0]).equals(players[8])
      const moved = await coach.warnings()
      expect(
        moved.find(line => line.startsWith('red noConsecutiveSits'))
      ).includes(`${senga}, ${marte}`)
      // Help and Clear, the grid and the warnings under it, in one frame.
      await coach.tallShot('coach-plan.png', '[data-testid="Plan scroll"]')
      // Saved anyway, and summarised. Before the first pitch the plan he
      // follows sets the defence from its inning 1, and the notice says so.
      await coach.tap('Save Rosters')
      const notice = await coach.page.waitForFunction(
        () => {
          const text = String(document.body.textContent)
          const at = text.indexOf('Saved. ')
          return at < 0 || !text.includes('Plan has ', at)
            ? false
            : text.slice(at, at + 120)
        },
        { timeout: 30000 }
      )
      expect(String(await notice.jsonValue())).match(
        /^Saved\. Defense set from the plan’s inning 1\. Plan has \d+ (red and \d+ yellow )?playing-time warnings?\./
      )
      const saved = (await storedPlan(ctx, fixture))!
      expect(saved.rows[0].cells.slice(0, 3)).deep.equals(['', '', ''])
      expect(saved.rows[0].player.fullName).equals(senga)
    },

    'p9-clear-asks-first': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const cells = await coach.cells()
      expect(cells[0][0]).equals('P')
      // Clear is at the top, right of Help.
      await coach.scrollTop('[data-testid="Plan scroll"]')
      await coach.tapCss('[data-testid="Plan clear"]')
      const sheet = '[aria-label="Clear the whole plan?"]'
      await coach.page.waitForSelector(sheet, { visible: true })
      await coach.shot('coach-plan-clear-confirm.png')
      const actions = await coach.page.$$eval(
        `${sheet} [role="button"]`,
        nodes =>
          nodes.map(node => ({
            text: String(node.textContent),
            color: getComputedStyle(node).backgroundColor
          }))
      )
      expect(actions.map(action => action.text)).deep.equals([
        'Clear',
        'Cancel'
      ])
      // Cancel: nothing changes.
      await coach.tapButtonIn(sheet, 'Cancel')
      await coach.page.waitForFunction(
        (selector: string) => document.querySelector(selector) == null,
        {},
        sheet
      )
      expect(await coach.cells()).deep.equals(cells)
      // Clear: every cell empty.
      await coach.tapCss('[data-testid="Plan clear"]')
      await coach.tapCss('[data-testid="Plan clear confirm"]')
      await coach.page.waitForFunction(
        (selector: string) => document.querySelector(selector) == null,
        {},
        sheet
      )
      const cleared = await coach.cells()
      expect(cleared.flat().every(cell => cell === '')).equals(true)
      expect(cleared).has.length(9)
    },

    // P10: the scorekeeper's screen downloads the home team's column for each
    // inning it enters and applies it, with no notice; a plan of no
    // positions moves nobody. In inning 3 the scorekeeper changes a fielder
    // by hand, and the head coach then changes inning 3 itself: the change
    // is heard on the game socket, the column downloaded again, and the hand
    // edit replaced. A save that changes only inning 5 sends nothing.
    'p10-scorekeeper-follows-each-inning': async ctx => {
      const lines: string[] = []
      const frames = async (coach: Web): Promise<string[]> =>
        (await coach.page.evaluate(
          () => (window as any).__planFrames
        )) as string[]
      const save = async (
        coach: Web,
        fixture: Lineup,
        cells: PlanCell[][],
        label: string
      ): Promise<string[]> => {
        await coach.page.evaluate(() => {
          ;(window as any).__planFrames.length = 0
        })
        lines.push(
          `$ PUT /games/${fixture.gameId}/plans/${fixture.teams.home} (${label})`
        )
        await savePlan(ctx, fixture, cells)
        await sleep(3000)
        const heard = await frames(coach)
        lines.push(
          heard.length === 0
            ? '  heard: nothing'
            : heard.map(frame => `  heard: ${frame}`).join('\n')
        )
        return heard
      }
      try {
        for (const enabled of [true, false]) {
          const toggle = enabled ? 'on' : 'off'
          const fixture = await lineupWorld(ctx)
          const coach = await open(ctx, fixture)
          await savePlan(ctx, fixture, enabled ? SHIFT_PLAN : NO_POSITIONS)
          await coach.as('scorekeeper')
          await coach.scoreGame()
          await coach.ball()
          await storedInning(ctx, fixture, 1)
          const opening = await homeDefense(ctx, fixture)
          // The defaults: the nine at P to RF in batting order.
          expect(opening).deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
          lines.push(`toggle ${toggle}, inning 1: ${named(fixture, opening)}`)
          await coach.endHalf()
          await coach.ball()
          await coach.endHalf()
          await storedInning(ctx, fixture, 2)
          const second = enabled
            ? await defenseBecomes(
                ctx,
                fixture,
                columnDefense(fixture, SHIFT_PLAN, 2)
              )
            : await homeDefense(ctx, fixture)
          lines.push(`toggle ${toggle}, inning 2: ${named(fixture, second)}`)
          expect(await coach.planNotice()).equals(false)
          expect(await coach.syncNotice()).equals(null)
          if (enabled) {
            expect(second).deep.equals(columnDefense(fixture, SHIFT_PLAN, 2))
            await coach.shot('scoring-plan-notice-after.png')
          } else expect(second).deep.equals(opening)
          await coach.ball()
          await coach.endHalf()
          await coach.ball()
          await coach.endHalf()
          await coach.ball()
          await storedInning(ctx, fixture, 3)
          const third = enabled
            ? await defenseBecomes(
                ctx,
                fixture,
                columnDefense(fixture, SHIFT_PLAN, 3)
              )
            : await homeDefense(ctx, fixture)
          lines.push(`toggle ${toggle}, inning 3: ${named(fixture, third)}`)
          if (!enabled) {
            expect(third).deep.equals(opening)
            continue
          }
          expect(third).deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
          // The scorekeeper's hand edit, then the coach's change to inning 3.
          await handSwap(ctx, fixture, '1B', '3B')
          await sleep(3000)
          // The screen reads that edit in as another device's change, and
          // stays the scoring device: it has scored here.
          lines.push(
            `after the hand edit: ${named(fixture, await homeDefense(ctx, fixture))}`
          )
          const heard = await save(
            coach,
            fixture,
            SHIFT_EDITED,
            'inning 3, in play, changed'
          )
          const replaced = await defenseBecomes(
            ctx,
            fixture,
            columnDefense(fixture, SHIFT_EDITED, 3)
          )
          lines.push(`after the coach's save: ${named(fixture, replaced)}`)
          expect(replaced).deep.equals(columnDefense(fixture, SHIFT_EDITED, 3))
          expect(heard.map(frame => JSON.parse(frame).data)).deep.equals([
            { teamId: fixture.teams.home, inning: 3 }
          ])
          await coach.shot('coach-edit-current-inning-after.png')
          // A change to inning 5 alone is heard by nobody.
          const later: PlanCell[][] = SHIFT_EDITED.map((row, at) =>
            at === 0 ? [...row.slice(0, 4), 'C', row[5]] : row
          )
          expect(
            await save(coach, fixture, later, 'inning 5 only changed')
          ).deep.equals([])
        }
      } finally {
        log(ctx, 'coach-edit-socket.log', lines)
      }
    },

    // P18: a plan filled for innings 1 and 2 only, with the home team's
    // sitting limits on, and then a plan with no positions.
    'p18-partly-filled-plan': async ctx => {
      const twoInnings: PlanCell[][] = SHIFT_PLAN.map(row => [
        row[2],
        row[1],
        '',
        '',
        '',
        ''
      ])
      const sits =
        /^(red|yellow) (noConsecutiveSits|maxSitsPerGame|equalSittingOrder)/
      const lines: string[] = []
      try {
        for (const [label, cells] of [
          ['innings 1-2', twoInnings],
          ['no positions', NO_POSITIONS]
        ] as const) {
          const planned = cells === twoInnings
          const fixture = await lineupWorld(ctx)
          const coach = await open(ctx, fixture)
          await teamRules(ctx, fixture, { enforceSittingLimits: true })
          await savePlan(ctx, fixture, cells)
          await coach.as('headCoach')
          await coach.coachGame()
          await coach.plan()
          const warnings = await coach.warnings()
          lines.push(`${label}, warnings: ${JSON.stringify(warnings)}`)
          expect(warnings.filter(line => sits.test(line))).deep.equals([])
          await coach.as('scorekeeper')
          await coach.scoreGame()
          await coach.ball()
          await storedInning(ctx, fixture, 1)
          const opening = await homeDefense(ctx, fixture)
          expect(opening).deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
          lines.push(`${label}, inning 1: ${named(fixture, opening)}`)
          await coach.endHalf()
          await coach.ball()
          await coach.endHalf()
          await coach.ball()
          await storedInning(ctx, fixture, 2)
          const afterFirst = planned
            ? await defenseBecomes(
                ctx,
                fixture,
                columnDefense(fixture, twoInnings, 2)
              )
            : await homeDefense(ctx, fixture)
          lines.push(`${label}, after the 1st: ${named(fixture, afterFirst)}`)
          expect(await coach.planNotice()).equals(false)
          expect(afterFirst).deep.equals(
            planned ? columnDefense(fixture, twoInnings, 2) : opening
          )
          await coach.endHalf()
          await coach.ball()
          await coach.endHalf()
          await coach.ball()
          await storedInning(ctx, fixture, 3)
          // The column, empty, is downloaded and applied before this reads.
          await sleep(3000)
          const afterSecond = await homeDefense(ctx, fixture)
          lines.push(`${label}, after the 2nd: ${named(fixture, afterSecond)}`)
          // Inning 3 is not planned: the defence stays as inning 2 left it.
          expect(await coach.syncNotice()).equals(null)
          expect(afterSecond).deep.equals(afterFirst)
          if (!planned) continue
          // Clear empties the plan, and the saved plan is off.
          await coach.as('headCoach')
          await coach.coachGame()
          await coach.plan()
          await coach.scrollTop('[data-testid="Plan scroll"]')
          await coach.tapCss('[data-testid="Plan clear"]')
          await coach.tapCss('[data-testid="Plan clear confirm"]')
          await coach.tap('Save Rosters')
          await coach.page.waitForSelector(
            '[aria-label="Save Rosters"][aria-disabled="true"]',
            { timeout: 30000 }
          )
          const stored = (await storedPlan(ctx, fixture))!
          lines.push(
            `${label}, cleared and saved: enabled ${String(stored.enabled)}`
          )
          expect(stored.enabled).equals(false)
          expect(
            stored.rows.every(row => row.cells.every(cell => cell === ''))
          ).equals(true)
        }
      } finally {
        log(ctx, 'plan-blank-columns.log', lines)
      }
    },

    // P21: the home team's inning download held unanswered drops the sync
    // card 10 seconds after it went out, and the defence stays; Accept keeps
    // it. At the next inning the download fails; Try again, once it is let
    // through, applies the column. Reopening the screen asks for nothing.
    'p21-sync-card-on-failed-download': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, SHIFT_PLAN)
      const mode = async (next: 'hold' | 'fail' | 'pass'): Promise<void> => {
        await coach.page.evaluate(
          (value: string, home: string) => {
            const innings = (window as any).__planInnings
            innings.mode = value
            innings.home = home
          },
          next,
          `/plans/${fixture.teams.home}/innings/`
        )
      }
      const asked = async (): Promise<string[]> =>
        (await coach.page.evaluate(
          () => (window as any).__planInnings.asked
        )) as string[]
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await mode('hold')
      await coach.ball()
      await storedInning(ctx, fixture, 1)
      const opening = await homeDefense(ctx, fixture)
      await coach.endHalf()
      await coach.ball()
      await coach.endHalf()
      const sent = Date.now()
      await coach.page.waitForSelector('[data-testid="planSyncNotice"]', {
        timeout: 20000
      })
      const waited = Date.now() - sent
      const lines = [
        `the card dropped after ${waited} ms: ${await coach.syncNotice()}`
      ]
      expect(waited).greaterThan(9000)
      expect(await coach.syncNotice()).equals(
        'Unable to sync new inning defensive lineup for HostsAcceptTry again'
      )
      await coach.shot('plan-sync-notice.png')
      expect(await homeDefense(ctx, fixture)).deep.equals(opening)
      await coach.tap('Accept')
      expect(await coach.syncNotice()).equals(null)
      await coach.ball()
      expect(await homeDefense(ctx, fixture)).deep.equals(opening)
      // Inning 3: the download fails, then Try again is let through.
      await mode('fail')
      await coach.endHalf()
      await coach.ball()
      await coach.endHalf()
      await coach.page.waitForSelector('[data-testid="planSyncNotice"]', {
        timeout: 20000
      })
      await mode('pass')
      await coach.tap('Try again')
      const applied = await defenseBecomes(
        ctx,
        fixture,
        columnDefense(fixture, SHIFT_PLAN, 3)
      )
      lines.push(`after Try again: ${named(fixture, applied)}`)
      expect(applied).deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
      expect(await coach.syncNotice()).equals(null)
      // Reopened, the screen asks for no inning: the new page's own log.
      const before = await asked()
      await coach.scoreGame()
      await sleep(3000)
      lines.push(`inning downloads: ${JSON.stringify(before)}`)
      log(ctx, 'plan-sync.log', lines)
      expect(await asked()).deep.equals([])
    },

    // P22: before the game's start time, an inning's end downloads nothing
    // the screen shows: the server refuses (planNotStarted), no card drops
    // and the defence stays.
    'p22-nothing-before-start-time': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, SHIFT_PLAN)
      await startGame(ctx, fixture, false)
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await coach.ball()
      await storedInning(ctx, fixture, 1)
      const opening = await homeDefense(ctx, fixture)
      await coach.endHalf()
      await coach.ball()
      await coach.endHalf()
      await coach.ball()
      await storedInning(ctx, fixture, 2)
      await sleep(3000)
      const refused = (await coach.page.evaluate(
        () => (window as any).__planInnings.answers
      )) as string[]
      log(ctx, 'plan-not-started.log', [`answers: ${JSON.stringify(refused)}`])
      expect(refused).has.length(2)
      expect(refused.every(line => line.startsWith('403 '))).equals(true)
      expect(await coach.syncNotice()).equals(null)
      expect(await homeDefense(ctx, fixture)).deep.equals(opening)
    },

    // P23: the home team's admin, who is neither its coach nor its
    // assistant, opens the coach screen by its address (an admin has no
    // Coach pill) and finds the Plan tab saying the plan is the coaches'.
    'p23-team-admin-told-plan-is-coaches': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, SHIFT_PLAN)
      await coach.as('teamAdmin')
      await coach.go(`/games/${fixture.gameId}/coach/${fixture.teams.home}`)
      await coach.page.waitForSelector('[aria-label="Save Rosters"]', {
        timeout: 60000
      })
      await coach.tap('Plan', 'tab')
      await coach.page.waitForFunction(
        () =>
          String(document.body.textContent).includes(
            "Only the team's coaches and assistants can see its game plan."
          ),
        { timeout: 15000 }
      )
      expect(await coach.page.$('[data-testid="Plan cell 1-1"]')).equals(null)
      await coach.shot('coach-plan-team-admin-after.png')
    },

    // P24: who reads and saves the home team's plan, and what the inning
    // route answers a scorekeeper, through the API.
    'p24-plan-access-by-role-and-time': async ctx => {
      const fixture = await lineupWorld(ctx)
      await savePlan(ctx, fixture, SHIFT_PLAN)
      const lines: string[] = []
      const ask = async (
        who: Person,
        method: 'GET' | 'PUT',
        path: string,
        body?: unknown
      ): Promise<{ status: number; body: unknown }> => {
        lines.push(`$ ${method} ${path} as ${who}`)
        const answer = await call(ctx, fixture, who, method, path, body)
        lines.push(`${answer.status} ${answer.text}`)
        return answer
      }
      try {
        const plansPath = `/games/${fixture.gameId}/plans`
        const homePath = `${plansPath}/${fixture.teams.home}`
        const stored = (
          (await ask('headCoach', 'GET', plansPath)).body as {
            home: { plan: GamePlan } | null
          }
        ).home
        expect(stored).not.equals(null)
        // The assistant reads and saves it as the head coach does.
        expect(
          ((await ask('assistant', 'GET', plansPath)).body as { home: unknown })
            .home
        ).deep.equals(stored)
        expect(
          (await ask('assistant', 'PUT', homePath, stored!.plan)).status
        ).equals(200)
        for (const who of ['scorekeeper', 'teamAdmin'] as const) {
          expect((await ask(who, 'GET', plansPath)).body).deep.equals({
            away: null,
            home: null
          })
          expect((await ask(who, 'PUT', homePath, stored!.plan)).status).equals(
            403
          )
        }
        expect(
          (await ask('headCoach', 'PUT', homePath, stored!.plan)).status
        ).equals(200)
        // The inning route, as the scorekeeper.
        const reasonOf = (body: unknown): unknown =>
          (body as { details?: { reason?: unknown } }).details?.reason
        const place = async (changes: {
          started: boolean
          inning: number | null
          status: 'scheduled' | 'inProgress' | 'final'
        }): Promise<void> => {
          await stackSql(
            ctx,
            `update games set start_at = now() + ($1::int * interval '1 hour'),
               status = $2, "currentPlay" = $3::jsonb where id = $4`,
            [
              changes.started ? -1 : 1,
              changes.status,
              changes.inning == null
                ? null
                : JSON.stringify({
                    about: {
                      atBatIndex: 6,
                      inning: changes.inning,
                      halfInning: 'top',
                      isTopInning: true,
                      isComplete: false,
                      hasOut: false,
                      hasReview: false
                    }
                  }),
              fixture.gameId
            ]
          )
        }
        lines.push(
          '# the game set to start in an hour, its innings moved on to the 2nd'
        )
        await place({ started: false, inning: 2, status: 'inProgress' })
        const early = await ask('scorekeeper', 'GET', `${homePath}/innings/2`)
        expect(early.status).equals(403)
        expect(reasonOf(early.body)).equals('planNotStarted')
        lines.push('# the game started an hour ago, in the 2nd')
        await place({ started: true, inning: 2, status: 'inProgress' })
        const now = await ask('scorekeeper', 'GET', `${homePath}/innings/2`)
        expect(now.status).equals(200)
        expect((now.body as { column: unknown[] }).column).has.length(9)
        const next = await ask('scorekeeper', 'GET', `${homePath}/innings/3`)
        expect(next.status).equals(409)
        expect(reasonOf(next.body)).equals('planInningNotCurrent')
        lines.push('# the game final after two innings')
        await place({ started: true, inning: null, status: 'final' })
        const over = await ask('scorekeeper', 'GET', `${homePath}/innings/3`)
        expect(over.status).equals(403)
        expect(reasonOf(over.body)).equals('planGameOver')
      } finally {
        log(ctx, 'plan-access.log', lines)
      }
    },

    // P26 beyond `position-errors#missing-and-doubled`: the errors come
    // before the warnings, the fourth doubled cell (2-2) is red and a whole
    // inning's (9-3) is not, and an added inning's number is that red.
    'p26-errors-before-warnings-and-added-inning-red': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, ERROR_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const before = await coach.page.evaluate(() => {
        const errors = document.querySelector(
          '[data-testid="Plan position errors"]'
        )
        const warnings = document.querySelector('[data-testid="Plan warnings"]')
        return (
          errors != null &&
          (warnings == null ||
            (errors.compareDocumentPosition(warnings) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0)
        )
      })
      expect(before).equals(true)
      const colour = async (id: string): Promise<string> =>
        await coach.page.$eval(`[data-testid="${id}"]`, node => {
          const text = node.querySelector('[dir="auto"]')
          // No `??` here: the page has no sucrase helpers.
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          return getComputedStyle(text == null ? node : text).color
        })
      expect(await colour('Plan cell 2-2'), '2-2').equals(RED)
      expect(await colour('Plan cell 9-3'), '9-3').not.equals(RED)
      await coach.tapCss('[data-testid="Plan add inning"]')
      await coach.page.waitForSelector('[data-testid="Plan inning 6"]')
      expect(await colour('Plan inning 6')).equals(RED)
      expect(await colour('Plan inning 5')).not.equals(RED)
    },

    // P28 beyond `share-print#share-and-print`: blue pills with white words,
    // Share left of Print, after the errors; where the browser shares no
    // files, Share downloads the whole plan on one Letter page, every row
    // drawn inside the margins.
    'p28-share-pills-and-download': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, ERROR_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      await coach.scrollToElement('[data-testid="Plan print"]')
      const layout = await coach.page.evaluate(() => {
        const box = (
          id: string
        ): {
          top: number
          bottom: number
          left: number
          right: number
        } | null => {
          const node = document.querySelector(`[data-testid="${id}"]`)
          if (node == null) return null
          const r = node.getBoundingClientRect()
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right
          }
        }
        const fill = (id: string): string =>
          getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!)
            .backgroundColor
        return {
          share: box('Plan share'),
          print: box('Plan print'),
          errors: box('Plan position errors'),
          warnings: box('Plan warnings'),
          shareFill: fill('Plan share'),
          printFill: fill('Plan print'),
          words: Array.from(
            document.querySelectorAll(
              '[data-testid="Plan share"] [dir="auto"], [data-testid="Plan print"] [dir="auto"]'
            )
          ).map(node => [
            String(node.textContent),
            getComputedStyle(node).color
          ])
        }
      })
      const { share, print, errors, warnings } = layout
      expect(share!.right).lessThan(print!.left)
      expect(Math.abs(share!.top - print!.top)).lessThan(1)
      // The world's team plays by no rules, so it has no warnings to show.
      expect(warnings).equals(null)
      expect(errors!.bottom).lessThan(share!.top)
      expect([layout.shareFill, layout.printFill]).deep.equals([
        'rgb(21, 101, 192)',
        'rgb(21, 101, 192)'
      ])
      expect(layout.words).deep.equals([
        ['Share', 'rgb(255, 255, 255)'],
        ['Print', 'rgb(255, 255, 255)']
      ])
      // Where the browser shares no files: a download, the whole plan on
      // one page.
      await coach.tapCss('[data-testid="Plan share"]')
      await coach.page.waitForFunction(
        () => (window as any).__planDownloads.length === 1,
        { timeout: 15000 }
      )
      const [downloaded] = (await coach.page.evaluate(
        () => (window as any).__planDownloads
      )) as Array<{ name: string; base64: string }>
      expect(downloaded.name).match(/^Hosts-game-plan-\d{4}-\d{2}-\d{2}\.pdf$/)
      const bytes = Buffer.from(downloaded.base64, 'base64')
      writeFileSync(ctx.artifact('plan-download.pdf'), bytes)
      const { readPlanPdf } = await import('../../../../src/test/planPdfReader')
      const read = readPlanPdf(new Uint8Array(bytes))
      log(ctx, 'plan-download.log', [
        `P28 layout: ${JSON.stringify(layout)}`,
        `P28 download: ${downloaded.name}, ${read.pages} page, MediaBox ${JSON.stringify(read.mediaBox)}`
      ])
      expect(read.pages).equals(1)
      expect(read.mediaBox).deep.equals([0, 0, 612, 792])
      const drawn = read.texts.map(text => text.text)
      expect(drawn[0]).match(/^Hosts game plan - Visitors - /)
      for (const row of await coach.planPlayers()) expect(drawn).includes(row)
      const held: string[] = ERROR_PLAN.flat().filter(cell => cell !== '')
      expect(
        read.texts
          .filter(text => text.bold && held.includes(text.text))
          .map(text => text.text)
          .sort()
      ).deep.equals([...held].sort())
      for (const text of read.texts) {
        expect(text.x).at.least(54)
        expect(text.y).within(54, 738)
      }
      expect(await coach.page.$('[data-testid="Plan document failed"]')).equals(
        null
      )
    },

    // P25: a scoring screen reopened in the 3rd, which has scored nothing
    // since, reads in a lineup edit made elsewhere and then the head coach's
    // change to inning 3, and puts the coach's column on the field.
    'p25-reopened-screen-takes-coach-change': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, SHIFT_PLAN)
      await coach.as('scorekeeper')
      await coach.scoreGame()
      for (let half = 0; half < 4; half++) {
        await coach.ball()
        await coach.endHalf()
      }
      await coach.ball()
      await storedInning(ctx, fixture, 3)
      await defenseBecomes(ctx, fixture, columnDefense(fixture, SHIFT_PLAN, 3))
      // Reopened, it scores nothing.
      await coach.scoreGame()
      await handSwap(ctx, fixture, '1B', '3B')
      await sleep(3000)
      const lines = [
        `after the lineup edit: ${named(fixture, await homeDefense(ctx, fixture))}`
      ]
      await savePlan(ctx, fixture, SHIFT_EDITED)
      const applied = await defenseBecomes(
        ctx,
        fixture,
        columnDefense(fixture, SHIFT_EDITED, 3)
      )
      lines.push(`after the coach's save: ${named(fixture, applied)}`)
      log(ctx, 'plan-reopened.log', lines)
      expect(applied).deep.equals(columnDefense(fixture, SHIFT_EDITED, 3))
    },

    'p11-scorekeeper-footer-and-field': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('scorekeeper')
      await coach.scoreGame()
      await coach.tap('Open scoring menu')
      await coach.tap('Set Team Rosters')
      await coach.page.waitForSelector('[aria-label="Save Rosters"]', {
        timeout: 30000
      })
      expectFooterRow(await coach.footer())
      await coach.defense()
      expectFooterRow(await coach.footer())
      const cards = await coach.fieldCards()
      expect(Object.keys(cards)).has.length(9)
      expect(Math.max(...cardRows(cards).map(row => row.length))).lessThan(3)
    },

    'p12-footer-fits-320-points': async ctx => {
      const fixture = await lineupWorld(ctx)
      const narrow = await open(ctx, fixture, NARROW)
      const lines: string[] = []
      try {
        await narrow.as('headCoach')
        await narrow.coachGame()
        await narrow.plan()
        await fits(narrow, 'coach Plan', lines)
        await narrow.as('scorekeeper')
        await narrow.scoreGame()
        await narrow.tap('Open scoring menu')
        await narrow.tap('Set Team Rosters')
        await narrow.page.waitForSelector('[aria-label="Save Rosters"]', {
          timeout: 30000
        })
        await narrow.defense()
        await fits(narrow, 'scorekeeper Defense', lines)
      } finally {
        log(ctx, 'footer-320.log', lines)
      }
    },

    'p13-opens-clean-after-scorekeeper-reorders': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, HOME_PLAN)
      const saveDisabled = async (): Promise<string | null> =>
        await coach.page.$eval('[aria-label="Save Rosters"]', node =>
          node.getAttribute('aria-disabled')
        )
      // The head coach saves his lineup, so the game holds it.
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.tap('Save Rosters')
      await coach.page.waitForSelector(
        '[aria-label="Save Rosters"][aria-disabled="true"]',
        { timeout: 30000 }
      )
      // The scorekeeper swaps the first and third batters.
      await postHomeLineup(ctx, fixture, order => {
        ;[order[0], order[2]] = [order[2], order[0]]
      })
      // The coach opens the game again: his plan's rows follow the new
      // order, and nothing is his to save.
      await coach.coachGame()
      await coach.plan()
      const names = fixture.players.home.map(player => player.name)
      expect(
        (await coach.planPlayers()).slice(0, 3).map(unnumbered)
      ).deep.equals([names[2], names[1], names[0]])
      expect(await coach.cells()).deep.include.ordered.members([
        HOME_PLAN[2],
        HOME_PLAN[1],
        HOME_PLAN[0]
      ])
      expect(await saveDisabled()).equals('true')
      await coach.tap('Back')
      await coach.page.waitForFunction(
        () => document.querySelector('[aria-label="Save Rosters"]') == null,
        { timeout: 15000 }
      )
      expect(
        await coach.page.evaluate(() => String(document.body.textContent))
      ).not.includes('Discard unsaved roster changes?')
    },

    'p14-saved-plan-sets-opening-defense': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      // Off: no cell holds a position.
      await savePlan(ctx, fixture, NO_POSITIONS)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      // He fills inning 1 from the picker, which turns the plan on.
      for (const [at, row] of OPENING_PLAN.entries()) {
        if (row[0] === '') continue
        await coach.click(`[data-testid="Plan cell ${at + 1}-1"]`)
        await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
          visible: true
        })
        await coach.click(`[data-testid="Plan pick ${row[0]}"]`)
        expect(await coach.cell(at + 1, 1)).equals(row[0])
      }
      await coach.tap('Save Rosters')
      await coach.page.waitForSelector(
        '[aria-label="Save Rosters"][aria-disabled="true"]',
        { timeout: 30000 }
      )
      const expected = columnDefense(fixture, OPENING_PLAN, 1)
      // The save is sent behind the screen: read until the game holds it.
      const held = await defenseBecomes(ctx, fixture, expected)
      log(ctx, 'plan-opening.log', [
        `positions, saved before the 1st: ${named(fixture, held)}`
      ])
      expect(held).deep.equals(expected)
      expect(held).not.deep.equals(columnDefense(fixture, SHIFT_PLAN, 3))
    },

    'p15-names-help-and-clear-row': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const players = await coach.planPlayers()
      expect(players).has.length(9)
      const names = fixture.players.home.map(
        player => `${player.name} #${player.jersey}`
      )
      expect(players).deep.equals(names.slice(0, 9))
      const layout = await coach.page.evaluate(() => {
        const box = (css: string): Box => {
          const r = document.querySelector(css)!.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        return {
          help: box('[data-testid="Plan help"]'),
          clear: box('[data-testid="Plan clear"]'),
          sheet: box('[data-testid="Plan sheet"]'),
          clears: document.querySelectorAll('[data-testid="Plan clear"]')
            .length,
          toggle:
            document.querySelector('[data-testid="Plan toggle row"]') != null ||
            document.querySelector(
              '[data-testid="Plan tab"] [role="switch"]'
            ) != null ||
            String(document.body.textContent).includes('Enable per-inning'),
          instruction: String(document.body.textContent).includes(
            'Drag a player to change the batting order'
          ),
          helpColor: getComputedStyle(
            document.querySelector('[data-testid="Plan help"] [dir="auto"]')!
          ).color,
          clearColor: getComputedStyle(
            document.querySelector('[data-testid="Plan clear"] [dir="auto"]')!
          ).color
        }
      })
      expect(layout.toggle).equals(false)
      expect(layout.instruction).equals(false)
      expect(layout.clears).equals(1)
      // One row: Help on the left, Clear on the right, both above the sheet.
      expect(Math.abs(layout.help.y - layout.clear.y)).lessThan(1)
      expect(layout.help.x + layout.help.width).lessThan(layout.clear.x)
      expect(layout.clear.x + layout.clear.width).greaterThan(WIDTH - 40)
      expect(layout.clear.y + layout.clear.height).at.most(layout.sheet.y + 1)
      // Blue Help, red Clear.
      expect(layout.helpColor).not.equals(layout.clearColor)
      expect(layout.clearColor).equals(RED)
      const text = await coach.helpSheet('Plan help')
      expect(text).equals(
        'Tap and hold a player to drag them to a new batting order. Tap or hold an inning slot to set a player’s position.'
      )
      const sheet = await coach.box('[data-testid="Scoring sheet"]')
      const words = await coach.box('[data-testid="Help sheet text"]')
      log(ctx, 'plan-help.log', [
        `P15 layout: ${JSON.stringify(layout)}`,
        `P15 help sheet ${JSON.stringify(sheet)}, words ${JSON.stringify(words)}`
      ])
      // As tall as its words, its title and Done: well under half the screen.
      expect(sheet.y + sheet.height).closeTo(HEIGHT, 2)
      expect(sheet.height).lessThan(HEIGHT / 3)
      expect(words.y).greaterThan(sheet.y)
      expect(words.y + words.height).lessThan(sheet.y + sheet.height)
      await coach.closeHelpSheet()
    },

    'p16-added-inning-red-and-deleted-on-confirm': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      await coach.tapCss('[data-testid="Plan add inning"]')
      await coach.page.waitForSelector('[data-testid="Plan inning 6"]')
      // Something in the added inning, which Cancel keeps.
      await coach.click('[data-testid="Plan cell 1-6"]')
      await coach.click('[data-testid="Plan pick SS"]')
      expect(await coach.cell(1, 6)).equals('SS')
      const headers = await coach.page.$$eval(
        '[data-testid^="Plan inning "]',
        nodes =>
          nodes.map(node => ({
            id: String(node.getAttribute('data-testid')),
            role: node.getAttribute('role'),
            color: getComputedStyle(node.querySelector('[dir="auto"]')!).color
          }))
      )
      expect(headers.map(header => header.id)).deep.equals(
        [1, 2, 3, 4, 5, 6].map(inning => `Plan inning ${inning}`)
      )
      // A plan opens with five innings: the sixth is the added one.
      for (const header of headers.slice(0, 5)) {
        expect(header.role, header.id).not.equals('button')
        expect(header.color, header.id).not.equals(RED)
      }
      expect(headers[5].role).equals('button')
      expect(headers[5].color).equals(RED)
      const confirm = '[aria-label="Delete inning 6?"]'
      // Inning 1's number does nothing.
      await coach.click('[data-testid="Plan inning 1"]')
      await sleep(400)
      for (const sheet of ['Delete inning 1?', 'Delete inning 6?'])
        expect(await coach.page.$(`[aria-label="${sheet}"]`)).equals(null)
      // Cancel keeps the inning.
      await coach.tapCss('[data-testid="Plan inning 6"]')
      await coach.page.waitForSelector(confirm, { visible: true })
      const actions = await coach.page.$$eval(
        `${confirm} [role="button"]`,
        nodes =>
          nodes.map(node => ({
            text: String(node.textContent),
            fill: getComputedStyle(node).backgroundColor
          }))
      )
      log(ctx, 'plan-delete-inning.log', [
        `P16 headers: ${JSON.stringify(headers)}`,
        `P16 confirmation: ${JSON.stringify(actions)}`
      ])
      expect(actions.map(action => action.text)).deep.equals([
        'Delete',
        'Cancel'
      ])
      await coach.tapButtonIn(confirm, 'Cancel')
      await coach.page.waitForFunction(
        (selector: string) => document.querySelector(selector) == null,
        {},
        confirm
      )
      expect(await coach.cell(1, 6)).equals('SS')
      // Delete removes it.
      await coach.tapCss('[data-testid="Plan inning 6"]')
      await coach.tapCss('[data-testid="Plan delete inning confirm"]')
      await coach.page.waitForFunction(
        () => document.querySelector('[data-testid="Plan inning 6"]') == null
      )
      expect(await coach.page.$('[data-testid="Plan cell 1-6"]')).equals(null)
      expect((await coach.cells())[0]).has.length(5)
    },

    'p17-picker-geometry-and-click-outside': async ctx => {
      const { fixture, coach } = await setUp(ctx)
      await savePlan(ctx, fixture, HOME_PLAN)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      const before = await coach.cells()
      await coach.click('[data-testid="Plan cell 2-3"]')
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      const drawn = await coach.page.evaluate(() => {
        const box = (node: Element): Box => {
          const r = node.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        const picker = document.querySelector(
          '[data-testid="Plan field picker"]'
        )!
        const chips: Record<string, Box> = {}
        for (const position of ['P', '1B', '2B', '3B', 'SS'])
          chips[position] = box(
            picker.querySelector(`[data-testid="Plan pick ${position}"]`)!
          )
        return {
          card: box(picker),
          field: box(picker.querySelector('svg')!),
          mound: box(picker.querySelector('svg circle')!),
          chips,
          enlarged:
            picker.querySelector('[data-testid="Plan pick enlarged"]') != null
        }
      })
      const lines = [`P17 picker: ${JSON.stringify(drawn)}`]
      expect(drawn.card.width).closeTo(0.85 * 320, 0.5)
      expect(drawn.enlarged).equals(false)
      // P's box centred on the mound.
      expect(centre(drawn.chips.P).x).closeTo(centre(drawn.mound).x, 1)
      expect(centre(drawn.chips.P).y).closeTo(centre(drawn.mound).y, 1)
      // The base drew 1B, 2B, 3B and SS where the Defense tab does; the
      // branch slides each half a box's diagonal toward second base.
      const { field } = drawn
      const at = ([x, y]: readonly [number, number]): Point => ({
        x: field.x + (field.width * x) / 100,
        y: field.y + (field.height * y) / 100
      })
      const bag = (x: number, y: number): Point => at([x / 3.6, y / 2.4])
      const [first, second, third] = [bag(269, 136), bag(180, 96), bag(91, 136)]
      const slide = Math.hypot(44, 26) / 2
      for (const [position, base, from] of [
        ['1B', [83, 56], first],
        ['2B', [69, 40], first],
        ['3B', [17, 56], third],
        ['SS', [31, 40], third]
      ] as const) {
        const old = at(base)
        const now = centre(drawn.chips[position])
        const [dx, dy] = [now.x - old.x, now.y - old.y]
        const [px, py] = [second.x - from.x, second.y - from.y]
        lines.push(
          `P17 ${position}: moved ${dx.toFixed(1)}, ${dy.toFixed(1)} (${Math.hypot(dx, dy).toFixed(1)} of ${slide.toFixed(1)})`
        )
        expect(Math.hypot(dx, dy), position).closeTo(slide, 1)
        // Along the path: the cross product, over the path's length, is the
        // distance off it.
        expect(
          Math.abs(dx * py - dy * px) / Math.hypot(px, py),
          position
        ).lessThan(1)
        expect(dy, position).lessThan(0)
      }
      log(ctx, 'plan-picker.log', lines)
      // A click outside, on the row above the sheet, closes it and changes
      // nothing.
      const row = await coach.box('[data-testid="Plan help row"]')
      await coach.clickAt(centre(row))
      await coach.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Plan field picker"]') == null,
        { timeout: 5000 }
      )
      expect(await coach.page.$('[data-testid="Help sheet text"]')).equals(null)
      expect(await coach.cells()).deep.equals(before)
      // So does a click on the Lineup tab, or on the Box Score pill, above
      // the sheet: the Plan tab stays.
      for (const target of [
        '[role="tab"][aria-label="Lineup"]',
        '[data-testid="Box Score pill"]'
      ]) {
        await coach.click('[data-testid="Plan cell 2-3"]')
        await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
          visible: true
        })
        await coach.clickAt(centre(await coach.box(target)))
        await coach.page.waitForFunction(
          () =>
            document.querySelector('[data-testid="Plan field picker"]') == null,
          { timeout: 5000 }
        )
        await sleep(500)
        expect(
          await coach.page.$('[data-testid="Plan sheet"]'),
          `${target} leaves the Plan tab`
        ).not.equals(null)
      }
      expect(await coach.cells()).deep.equals(before)
    },

    'p20-spreadsheet-keys-copy-and-paste': async ctx => {
      const { coach } = await setUp(ctx)
      await coach.as('headCoach')
      await coach.coachGame()
      await coach.plan()
      // Where the focus was before each key: never a text field.
      const focused: string[] = []
      const press = async (key: string): Promise<void> => {
        const { focused: at, inputs } = await coach.planFocus()
        expect(inputs).equals(0)
        focused.push(at)
        await coach.key(key)
        // Long enough, recorded, for each key's frame to be seen.
        await sleep(700)
      }
      const recording = ctx.artifact('plan-keyboard.mp4')
      await coach.m.startRecording({ path: recording })
      try {
        await coach.click('[data-testid="Plan cell 1-1"]')
        await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
          visible: true
        })
        await sleep(400)
        await press('1')
        expect(await coach.cell(1, 1)).equals('1B')
        await press('ArrowRight')
        await press('s')
        expect(await coach.cell(1, 2)).equals('SS')
        await press('ArrowDown')
        await press('c')
        // C waits, shown, for an F.
        expect(await coach.cell(2, 2)).equals('C')
        await press('f')
        expect(await coach.cell(2, 2)).equals('CF')
        expect((await coach.planFocus()).lit).deep.equals(['Plan cell 2-2'])
        // Copy SS from inning 2 and paste it two cells away, in inning 4.
        await press('ArrowUp')
        expect(await coach.clipboard('copy')).equals('SS')
        await press('ArrowRight')
        await press('ArrowRight')
        await coach.clipboard('paste', 'SS')
        expect(await coach.cell(1, 4)).equals('SS')
        // Pasted with no edit opened: still highlighted, and no field holds
        // the focus.
        expect(await coach.planFocus()).deep.equals({
          focused: 'DIV Plan grid',
          inputs: 0,
          selection: '',
          lit: ['Plan cell 1-4']
        })
        // X is no position: refused, the cell kept.
        await coach.clipboard('paste', 'X')
        expect(await coach.cell(1, 4)).equals('SS')
        expect(
          await coach.page.$eval(
            '[data-testid="Plan refusal"]',
            node => node.textContent
          )
        ).includes('X is not a position')
        await sleep(800)
      } finally {
        await coach.m.stopRecording({ path: recording })
      }
      expect(
        focused.every(at => at === 'DIV Plan grid'),
        focused.join(', ')
      ).equals(true)
      const cells = await coach.cells()
      expect([cells[0].slice(0, 4), cells[1].slice(0, 2)]).deep.equals([
        ['1B', 'SS', cells[0][2], 'SS'],
        [cells[1][0], 'CF']
      ])
      log(ctx, 'plan-keyboard.log', [
        `P20 focus before each key: ${focused.join(', ')}`
      ])
      // Tab after a letter writes it, the cell still lit and taking keys; a
      // Tab with nothing typed leaves the cells, none lit.
      await coach.click('[data-testid="Plan cell 3-1"]')
      await coach.page.waitForSelector('[data-testid="Plan field picker"]', {
        visible: true
      })
      await press('Escape')
      await press('c')
      await press('Tab')
      expect(await coach.cell(3, 1)).equals('C')
      expect((await coach.planFocus()).lit).deep.equals(['Plan cell 3-1'])
      await press('Tab')
      expect((await coach.planFocus()).lit).deep.equals([])
      await coach.key('p')
      expect(await coach.cell(3, 1)).equals('C')
    }
  }
})
