import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { record, type Recording } from '../../../../tools/eventControl/recorder'
import { flatten, type HierarchyNode, maestroBin, maestroClient, type MaestroDevice } from '../../../test/maestroD'

/**
 * Device event control on real devices: Director sets the publishing event of
 * nearby receivers signed in to its own account, in two steps.
 *
 *   node -r sucrase/register mobile/apps/tsDirector/e2e/eventControl.e2e.ts \
 *     --step <discovery|receiver|all>
 *
 *   discovery  Director, built for the seat and signed in as account One
 *              with games A and B in its picker, finds `tools/eventControl`
 *              receivers through its camera sweep on its own subnet and on an
 *              additional one, assigns A, reaches a late receiver and one
 *              restarted on the same address, moves every eligible receiver
 *              to B, leaves a receiver of account Two and one that does not
 *              allow override alone, and releases them all when turned off.
 *   receiver   One Cameraman (CAMERAMAN_PLATFORM ios or android), signed in
 *              as One: opt in, the Director's address and a locked event row,
 *              a radar reading reaching A and a fresh one reaching B, a second
 *              Director answered busy, a Director that vanishes (its lease
 *              runs out, the event stays), Director turned off (released at
 *              once), and opting out.
 *
 * Every device, address, account and game comes from the environment; this
 * file names none. Director and the Cameraman are launched with `uiTest`, so
 * Director answers `/dump-state` on its control port and the Cameraman takes
 * the `radar-feed` test command (a reading as the paired radar would report
 * it; on iOS over its control port, on Android as a `tscameraman://` intent).
 * What reaches each game's scoreboard is read with `tools/eventControl/
 * recorder.ts`, so a reading counts only when the seat says it arrived.
 *
 *   MAESTRO_D                 this run's maestro-d daemon
 *   MAESTRO_D_TEAM_ID         WebDriverAgent signing team (iOS devices)
 *   DIRECTOR_DEVICE_UDID      the iPad (hardware UDID)
 *   DIRECTOR_CONTROL_URL      http://<iPad address>:8765
 *   SEAT_URL                  https://<seat host>
 *   TOKEN_ONE_FILE            a session token file for account One
 *   TOKEN_TWO_FILE            a session token file for account Two
 *   GAME_A, GAME_B            two of One's games, both in Director's picker
 *   GAME_A_TITLE, GAME_A_START, GAME_B_TITLE, GAME_B_START
 *                             their titles ("Away at Home") and start times
 *                             (YYYY-MM-DDTHH:MM:SSZ)
 *   LOCAL_PEER_HOST           an address of this machine on Director's subnet
 *   EXTRA_PEER_HOST           an address of this machine on another subnet
 *                             Director can route to
 *   EXTRA_SUBNETS             Director's additional subnets, comma-separated
 *                             /24 network addresses, one of them
 *                             EXTRA_PEER_HOST's; swept in addition to
 *                             Director's own (set as Settings would)
 *   CAMERAMAN_PLATFORM        receiver: ios | android
 *   CAMERAMAN_DEVICE          receiver: the iPhone's hardware UDID or the
 *                             Android serial
 *   CAMERAMAN_HOST            receiver: the Cameraman's address, as Director
 *                             sees it
 *
 * Screenshots go to E2E_ARTIFACT_DIR (default /tmp/maestroD/<daemon>/…).
 */

const DIRECTOR_APP = 'app.teamstation.director'
const CAMERAMAN_APP = 'app.teamstation.cameraman'
const PORTS = [47614, 47615]

// MARK: - Environment

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

interface Game {
  id: string
  title: string
  start: string
}

const game = (name: 'A' | 'B'): Game => ({
  id: required(`GAME_${name}`),
  title: required(`GAME_${name}_TITLE`),
  start: required(`GAME_${name}_START`)
})

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))
const stamp = (): string => new Date().toISOString().slice(11, 23)
const say = (line: string): void => console.log(`${stamp()} ${line}`)

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`)
  say(`ok: ${what}`)
}

/** Waits for `test` to hold, polling every `everyMs`, at most `limitMs`. */
async function until<T>(what: string, limitMs: number, test: () => Promise<T | undefined>, everyMs = 2_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await test()
    if (value !== undefined) {
      say(`ok: ${what} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
      return value
    }
    if (Date.now() - started > limitMs) throw new Error(`FAILED: ${what}, not within ${limitMs / 1000} s`)
    await sleep(everyMs)
  }
}

// MARK: - maestro-d

interface Device extends MaestroDevice {
  setOrientation: (value: unknown) => Promise<unknown>
}

let daemon: { attach: (options: Record<string, unknown>) => Promise<MaestroDevice> } | undefined
const held = new Map<string, Device>()

async function device(id: string, platform: 'ios' | 'android', appId: string): Promise<Device> {
  const known = held.get(`${id}/${appId}`)
  if (known != null) return known
  if (daemon == null) {
    const bin = maestroBin()
    console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())
    daemon = await maestroClient().MaestroD.connect({ name: required('MAESTRO_D'), bin })
  }
  const teamId = process.env.MAESTRO_D_TEAM_ID ?? ''
  const m = (await daemon.attach({
    device: id,
    platform,
    appId,
    ...(platform === 'ios' && teamId !== '' ? { teamId } : {})
  })) as Device
  held.set(`${id}/${appId}`, m)
  return m
}

async function nodeById(m: MaestroDevice, id: string): Promise<HierarchyNode | undefined> {
  return flatten(await m.hierarchy()).find(node => node.id === id && node.bounds != null)
}

async function isVisible(m: MaestroDevice, id: string, timeout = 1_000): Promise<boolean> {
  return await m.assertVisible({ id, timeout }).then(() => true, () => false)
}

/**
 * Taps a switch row's switch, which sits at the row's trailing end. On Android the row is the
 * switch, and a point is judged in the portrait frame while the Cameraman runs in landscape, so the
 * row is tapped by its ID instead.
 */
async function tapSwitch(m: MaestroDevice, id: string, platform: 'ios' | 'android' = 'ios'): Promise<void> {
  if (platform === 'android') {
    await m.tapOn({ id })
    await sleep(1_000)
    return
  }
  const box = (await nodeById(m, id))?.bounds
  if (box == null) throw new Error(`${id} is not on screen`)
  await m.tapOn({ point: `${Math.round(box.x + box.width - 30)},${Math.round(box.y + box.height / 2)}` })
  await sleep(1_000)
}

// MARK: - Director

const control = (): string => required('DIRECTOR_CONTROL_URL').replace(/\/+$/, '')

interface PeerState {
  endpoint: string
  instanceId: string
  state: string
  consent?: boolean
  ackedRevision?: number
}

interface EventControlState {
  enabled: boolean
  phase: string
  status: string
  revision: number
  gameId: string
  sweeper: string
  sweeps: number
  peers: PeerState[]
}

async function directorCommand(path: string): Promise<unknown> {
  const response = await fetch(`${control()}/${path}`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Director ${path} answered ${response.status}`)
  return await response.json()
}

async function directorState(): Promise<{ eventControl: EventControlState, discoveryStatus: string }> {
  return (await directorCommand('dump-state')) as { eventControl: EventControlState, discoveryStatus: string }
}

/** The peer Director knows at `endpoint`, once it has an instance ID. */
async function peerAt(endpoint: string): Promise<PeerState | undefined> {
  const { eventControl } = await directorState()
  return eventControl.peers.find(peer => peer.endpoint === endpoint && peer.instanceId !== '')
}

async function directorSettings(): Promise<Device> {
  const m = await device(required('DIRECTOR_DEVICE_UDID'), 'ios', DIRECTOR_APP)
  if (await isVisible(m, 'settings-event-control-enabled')) return m
  for (let i = 0; i < 20; i++) {
    if (await isVisible(m, 'start-directing', 500)) await m.tapOn({ id: 'start-directing' })
    if (await isVisible(m, 'settings-button', 500)) break
  }
  await m.tapOn({ id: 'settings-button' })
  await m.extendedWaitUntil({ visible: { id: 'settings-event-control-enabled' }, timeout: 20_000 })
  return m
}

async function launchDirector(): Promise<Device> {
  const m = await device(required('DIRECTOR_DEVICE_UDID'), 'ios', DIRECTOR_APP)
  await m.launchApp({ appId: DIRECTOR_APP, stopApp: true, arguments: { uiTest: true, testClock: false } })
  await until('Director answers on its control port', 60_000, async () => await directorState().then(() => true, () => undefined))
  return await directorSettings()
}

async function setDirectorControl(on: boolean): Promise<void> {
  const m = await directorSettings()
  if ((await directorState()).eventControl.enabled !== on) await tapSwitch(m, 'settings-event-control-enabled')
  await until(`Director's "Set event on nearby devices" is ${on ? 'on' : 'off'}`, 10_000, async () =>
    (await directorState()).eventControl.enabled === on ? true : undefined, 500)
}

/**
 * Picks `g` in Director's event picker. A pick under "Use a TeamStation event"
 * also claims the game for the programme stream, which a seat with live
 * streaming off refuses, so the stream-URL choice is made first (unsaved).
 */
async function pickOnDirector(g: Game): Promise<number> {
  const m = await directorSettings()
  if (await isVisible(m, 'settings-stream-destination-url')) {
    await m.tapOn({ id: 'settings-stream-destination-url' })
    await m.hideKeyboard().catch(() => undefined)
  }
  await m.tapOn({ id: 'settings-teamstation-event' })
  await m.extendedWaitUntil({ visible: { id: `event-picker-row-${g.id}` }, timeout: 20_000 })
  await m.tapOn({ id: `event-picker-row-${g.id}` })
  return await until(`Director selected ${g.title}`, 15_000, async () => {
    const { eventControl } = await directorState()
    return eventControl.gameId === g.id ? eventControl.revision : undefined
  }, 250)
}

// MARK: - Receivers on this machine

interface Peer {
  name: string
  endpoint: string
  lines: Array<Record<string, unknown>>
  child: ChildProcess
}

const peers = new Map<string, Peer>()

/** A `tools/eventControl/peer.ts` receiver; its instance ID is fixed by its name, as an app's is. */
function startPeer(name: string, host: string, port: number, tokenFile: string, extra: string[] = []): Peer {
  const instance = createHash('sha256').update(name).digest('hex').slice(0, 32)
  const child = spawn(process.execPath, [
    '-r', 'sucrase/register', 'tools/eventControl/peer.ts',
    '--server', required('SEAT_URL'), '--token-file', tokenFile,
    '--host', host, '--port', String(port), '--instance', instance, ...extra
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  const peer: Peer = { name, endpoint: `${host}:${port}`, lines: [], child }
  createInterface({ input: child.stdout! }).on('line', text => {
    try {
      const line = JSON.parse(text) as Record<string, unknown>
      peer.lines.push(line)
      if (['apply', 'overrideEnded', 'listening'].includes(String(line.event))) {
        say(`[${name}] ${String(line.event)} ${String(line.gameId ?? line.reason ?? line.port ?? '')}`)
      }
    } catch {}
  })
  peers.set(name, peer)
  say(`receiver ${name} on ${peer.endpoint}${extra.length > 0 ? ` (${extra.join(' ')})` : ''}`)
  return peer
}

async function stopPeer(name: string): Promise<void> {
  const peer = peers.get(name)
  if (peer == null) return
  peers.delete(name)
  peer.child.kill('SIGTERM')
  await new Promise(resolve => peer.child.once('exit', resolve))
}

const applied = (peer: Peer): string[] =>
  peer.lines.filter(line => line.event === 'apply' && line.status === 'applied').map(line => String(line.gameId))

// MARK: - discovery step

async function discovery(): Promise<void> {
  const A = game('A')
  const B = game('B')
  const local = required('LOCAL_PEER_HOST')
  const extra = required('EXTRA_PEER_HOST')
  const one = required('TOKEN_ONE_FILE')
  const two = required('TOKEN_TWO_FILE')

  await launchDirector()
  await setDirectorControl(false)
  // The additional subnet is swept as well as Director's own, never instead of it.
  const additional = required('EXTRA_SUBNETS').split(',').map(subnet => subnet.trim())
  await directorCommand(`subnet-scan?subnet=${encodeURIComponent(additional.join(','))}&on=1`)
  const scan = (await directorState()).discoveryStatus
  say(`discovery: ${scan}`)
  const subnets = /scan=([^ ]+)/.exec(scan)?.[1].split(',') ?? []
  check(subnets.length > additional.length && additional.every(subnet => subnets.includes(`${subnet}/24`)),
    `the sweep covers Director's own subnet as well as ${additional.join(', ')} (${subnets.join(', ')})`)

  const localOne = startPeer('local-one', local, PORTS[0], one)
  const localTwo = startPeer('local-two', local, PORTS[1], two)
  const extraDisabled = startPeer('extra-disabled', extra, PORTS[1], one, ['--disabled'])
  await sleep(3_000)
  await pickOnDirector(A)
  const sweepsBefore = (await directorState()).eventControl.sweeps
  await setDirectorControl(true)

  // A receiver Director has never seen is found by the camera sweep, whose result routes the
  // event ports here; one it remembers is contacted at its address straight away.
  await until('the local receiver applies A', 600_000, async () =>
    applied(localOne).includes(A.id) ? true : undefined, 5_000)
  await until('a camera sweep carrying the event ports reaches event control', 900_000, async () => {
    const { eventControl, discoveryStatus } = await directorState()
    return eventControl.sweeps > sweepsBefore ? `${eventControl.sweeps} (${discoveryStatus})` : undefined
  }, 5_000)
  check((await directorState()).eventControl.sweeper === 'shared', 'one sweep serves cameras and receivers (sweeper=shared)')
  check((await peerAt(localOne.endpoint))?.state.startsWith('applied') === true, 'Director shows the local receiver applied')
  await until('the account-Two receiver is seen as another account', 60_000, async () =>
    (await peerAt(localTwo.endpoint))?.state === 'otherAccount' ? true : undefined)
  await until('the receiver without consent is seen as not allowing override', 60_000, async () =>
    (await peerAt(extraDisabled.endpoint))?.state === 'disabled' ? true : undefined)

  // A receiver that starts late, on the additional subnet.
  const extraOne = startPeer('extra-one', extra, PORTS[0], one)
  await until('the late receiver on the additional subnet applies A', 600_000, async () =>
    applied(extraOne).includes(A.id) ? true : undefined, 5_000)

  // A receiver restarted on the same address and port, with its instance ID.
  await stopPeer('local-one')
  await sleep(10_000)
  const restarted = startPeer('local-one', local, PORTS[0], one)
  await until('the restarted receiver is assigned again without a sweep', 60_000, async () =>
    applied(restarted).includes(A.id) ? true : undefined, 1_000)

  const revisionB = await pickOnDirector(B)
  for (const peer of [restarted, extraOne]) {
    await until(`${peer.name} moves to B`, 30_000, async () => applied(peer).includes(B.id) ? true : undefined, 500)
  }
  const both = await directorState()
  check(both.eventControl.peers.filter(peer => peer.state === `applied(${revisionB})`).length >= 2,
    'Director shows the eligible receivers applied at B\'s revision')
  check(applied(localTwo).length === 0, 'the account-Two receiver never applied anything')
  check(applied(extraDisabled).length === 0, 'the receiver without consent never applied anything')

  await setDirectorControl(false)
  for (const peer of [restarted, extraOne]) {
    await until(`${peer.name} is released`, 10_000, async () =>
      peer.lines.some(line => line.event === 'overrideEnded' && line.reason === 'released') ? true : undefined, 250)
  }
  const frames = (peer: Peer): number => peer.lines.filter(line => line.event === 'in' && line.type !== 'discover').length
  const counts = [restarted, extraOne].map(frames)
  await sleep(20_000)
  check([restarted, extraOne].every((peer, i) => frames(peer) === counts[i]), 'no assignment or renewal after Director is off')
  for (const name of [...peers.keys()]) await stopPeer(name)
}

// MARK: - receiver step

interface Receiver {
  m: Device
  platform: 'ios' | 'android'
  endpoint: string
  ids: { consent: string, source: string, status: string, event: string }
}

async function launchReceiver(): Promise<Receiver> {
  const platform = required('CAMERAMAN_PLATFORM') as 'ios' | 'android'
  const m = await device(required('CAMERAMAN_DEVICE'), platform, CAMERAMAN_APP)
  await m.launchApp({ appId: CAMERAMAN_APP, stopApp: true, arguments: { uiTest: true, persistSettings: true } })
  await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30_000 })
  // Taps are judged in the portrait frame on an iPhone.
  if (platform === 'ios') await m.setOrientation({ orientation: 'PORTRAIT', optional: true })
  await sleep(1_500)
  await m.tapOn({ id: 'settings-button' })
  await m.extendedWaitUntil({ visible: { id: 'scoreboard-account-server' }, timeout: 20_000 })
  const ids = platform === 'ios'
    ? {
        consent: 'scoreboard-allow-director-override',
        source: 'scoreboard-override-source',
        status: 'scoreboard-event-control-status',
        event: 'scoreboard-choose-event'
      }
    : {
        consent: 'scoreboard-allow-override',
        source: 'scoreboard-override-from',
        status: 'scoreboard-override-status',
        event: 'scoreboard-choose-event'
      }
  // Up the sheet until the switch is on screen (dragging down would close an iOS sheet). In
  // points, not percentages: percentages are taken in the portrait frame, and the Android
  // Cameraman runs in landscape.
  const screen = flatten(await m.hierarchy()).find(node => node.bounds != null && node.bounds.width > 0)!.bounds!
  for (let swipes = 0; swipes < 10; swipes++) {
    const box = (await nodeById(m, ids.consent))?.bounds
    if (box != null && box.y > 0 && box.y + box.height < screen.height * 0.9) break
    const x = Math.round(screen.x + screen.width * (platform === 'ios' ? 0.04 : 0.5))
    await m.swipe({
      startX: x, startY: Math.round(screen.height * 0.75), endX: x, endY: Math.round(screen.height * 0.35), duration: 500
    })
    await sleep(700)
  }
  return { m, platform, endpoint: `${required('CAMERAMAN_HOST')}:${PORTS[0]}`, ids }
}

/** Sends one radar reading the way the paired radar would. */
async function radarReading(r: Receiver, pitch: number): Promise<void> {
  if (r.platform === 'ios') {
    const response = await fetch(`http://${required('CAMERAMAN_HOST')}:8766/radar-feed?pitch=${pitch}&exit=0`)
    check(response.ok, `the Cameraman took a ${pitch} mph reading`)
  } else {
    execFileSync('adb', ['-s', required('CAMERAMAN_DEVICE'), 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
      '-d', `'tscameraman://test/radar-feed?pitch=${pitch}&exit=0&now=${Date.now()}'`, CAMERAMAN_APP])
    say(`sent a ${pitch} mph reading`)
  }
}

/**
 * What the Cameraman's event rows show. With "Allow Director Override" on, a
 * line sits under the switch: the controlling Director, or why none is.
 */
async function receiverRow(r: Receiver): Promise<{ consent: boolean, source?: string, event?: string, eventEnabled: boolean }> {
  type Node = HierarchyNode & { enabled?: boolean, checked?: boolean }
  const nodes = flatten(await r.m.hierarchy()) as Node[]
  const find = (id: string): Node | undefined => nodes.find(node => node.id === id && node.bounds != null)
  // A row's words are its own text or, in Compose, its children's.
  const words = (node: Node | undefined): string | undefined => {
    if (node == null) return undefined
    if (node.text != null && node.text !== '') return node.text
    const texts = flatten(node).map(child => child.text).filter((text): text is string => text != null && text !== '')
    return texts.length > 0 ? texts.join(', ') : undefined
  }
  const source = words(find(r.ids.source))
  const event = find(r.ids.event)
  const consent = find(r.ids.consent)
  return {
    consent: consent?.checked ?? (source != null || find(r.ids.status) != null),
    source,
    event: words(event),
    eventEnabled: event?.enabled !== false
  }
}

async function receiver(): Promise<void> {
  const A = game('A')
  const B = game('B')
  const recordings: Recording[] = []
  const seen: Record<string, number[]> = { [A.id]: [], [B.id]: [] }
  for (const g of [A, B]) {
    recordings.push(record({
      server: required('SEAT_URL'),
      token: readFileSync(required('TOKEN_ONE_FILE'), 'utf8').trim(),
      gameId: g.id,
      log: line => {
        const state = line.state as { pitchSpeed?: number } | undefined
        if (line.event === 'scoreboard' && state?.pitchSpeed != null && state.pitchSpeed > 0) {
          seen[g.id].push(state.pitchSpeed)
          say(`[scoreboard ${g.title}] pitch ${state.pitchSpeed}`)
        }
      }
    }))
  }
  try {
    await launchDirector()
    await pickOnDirector(A)
    await setDirectorControl(true)
    const r = await launchReceiver()
    if (!(await receiverRow(r)).consent) await tapSwitch(r.m, r.ids.consent, r.platform)
    check((await receiverRow(r)).consent, 'Allow Director Override is on')
    const directorHost = new URL(control()).hostname
    await until('Director assigns A to the Cameraman', 600_000, async () =>
      (await peerAt(r.endpoint))?.state.startsWith('applied') === true ? true : undefined, 5_000)
    const locked = await until('the Cameraman shows the Director and a locked event', 20_000, async () => {
      const row = await receiverRow(r)
      return row.source?.includes(directorHost) === true && !row.eventEnabled && row.event?.includes(A.title) === true ? row : undefined
    })
    say(`receiver: ${JSON.stringify(locked)}`)

    await radarReading(r, 61)
    await until('the reading reaches A', 10_000, async () => seen[A.id].includes(61) ? true : undefined, 250)
    await pickOnDirector(B)
    await until('the Cameraman applies B', 15_000, async () => (await receiverRow(r)).event?.includes(B.title) === true ? true : undefined, 500)
    await radarReading(r, 61)
    await until('a fresh reading equal to the last reaches B', 10_000, async () => seen[B.id].includes(61) ? true : undefined, 250)
    check(seen[A.id].filter(speed => speed === 61).length === 1, 'nothing more reached A')

    // A second Director with the same account is told the lease is held.
    const second = execFileSync(process.execPath, [
      '-r', 'sucrase/register', 'tools/eventControl/director.ts', '--server', required('SEAT_URL'),
      '--token-file', required('TOKEN_ONE_FILE'), '--peer', r.endpoint, '--game', A.id,
      '--title', A.title, '--start', A.start, '--hold', '1'
    ], { encoding: 'utf8' })
    check(second.includes('"event":"exit","status":"busy"'), 'a second Director is answered busy')

    // Director vanishes: the lease runs out and the event stays.
    await directorCommand('crash').catch(() => undefined)
    await until('the lease runs out: the event row unlocks and keeps B', 40_000, async () => {
      const row = await receiverRow(r)
      return row.source == null && row.eventEnabled && row.event?.includes(B.title) === true ? true : undefined
    })
    await launchDirector()
    await until('the relaunched Director assigns again', 60_000, async () =>
      (await peerAt(r.endpoint))?.state.startsWith('applied') === true ? true : undefined, 1_000)

    await setDirectorControl(false)
    await until('Director off releases the Cameraman at once', 10_000, async () =>
      (await receiverRow(r)).source == null ? true : undefined, 500)
    await setDirectorControl(true)
    await until('assigned again', 60_000, async () =>
      (await peerAt(r.endpoint))?.state.startsWith('applied') === true ? true : undefined, 1_000)

    await tapSwitch(r.m, r.ids.consent, r.platform)
    await until('opting out unlocks the event row and keeps the event', 10_000, async () => {
      const row = await receiverRow(r)
      return !row.consent && row.eventEnabled && row.event?.includes(B.title) === true ? true : undefined
    }, 500)
  } finally {
    for (const recording of recordings) recording.stop()
  }
}

// MARK: - Run

async function main(): Promise<void> {
  const at = process.argv.indexOf('--step')
  const step = at >= 0 ? process.argv[at + 1] : 'all'
  if (step === 'discovery' || step === 'all') await discovery()
  if (step === 'receiver' || step === 'all') await receiver()
  if (!['discovery', 'receiver', 'all'].includes(step)) throw new Error(`unknown step ${step}`)
  say('passed')
}

main().then(
  () => process.exit(0),
  async error => {
    console.error(error instanceof Error ? error.message : error)
    for (const name of [...peers.keys()]) await stopPeer(name)
    process.exit(1)
  }
)
