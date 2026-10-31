// E18: a phone's recording that was never uploaded leaves its owner a
// reminder in Notifications. The header's dot shows it, Upload opens the
// game's Videos tab, Dismiss settles it, History opens it without anything to
// accept, and an upload naming the angle's stream clears the next one by
// itself. Through maestro-d's JavaScript client, on an iOS simulator or an
// iPhone.
//
//   TS_STREAM_IOS_UDID=<device> MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for a real device>] \
//   TS_STREAM_API=http://<address>:<port>/api/v1 \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user who may film> TS_STREAM_GAME=<a game> \
//   TS_STREAM_UPLOAD_FILE=<a short .mp4 to upload as the recording; not
//     needed after E15> \
//   [TS_STREAM_AFTER_E15=1] \
//   [TS_STREAM_ANGLE=Home Plate] [TS_STREAM_SECOND_ANGLE=First Base] \
//   [TS_STREAM_DEVICE_MODEL=iPhone 13 Pro] \
//   [TS_STREAM_TOKEN=<session>] [TS_STREAM_ARTIFACT_DIR=<dir>] \
//     node -r sucrase/register src/app/stream/uploadReminder.e2e.ts
//
// The reminders are made over the API, posing as a phone of this script's
// own (a fixed device id): the angle's stream is requested, then marked
// `localRecording: 'recorded'`, as the streaming screen does when a take
// stops. This person's reminders left pending by earlier runs are dismissed
// first, so the card and the dot are this run's alone. Use an account no other
// run is streaming with at the same time, since its reminders would join the
// list while this one runs.
//
//   1. assertVisible the header's pending dot, then tapOn the bell.
//   2. assertVisible the reminder's title and description; takeScreenshot.
//   3. tapOn Upload: the game's Videos tab opens. Back.
//   4. tapOn Dismiss: the card goes, and the dot clears when nothing else is
//      pending.
//   5. History, then a reminder: its detail shows Upload and no Accept
//      invitation; this run's reminder, opened by its address, too.
//   6. A second angle's reminder is listed, then an upload naming its stream
//      with `wholeStream` clears it with nothing pressed.
//
// With TS_STREAM_AFTER_E15=1 it runs as the plan has it, on the simulator
// after E15 and E16, and makes nothing of its own: the reminder is the one
// E15's stop left for TS_STREAM_ANGLE (only other reminders are dismissed
// first), and step 6 finds the reminder for TS_STREAM_SECOND_ANGLE, the
// Pixel's, settled by E16's upload with nothing pressed: in History, not in
// Pending.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  id?: string
  text?: string
  bounds?: Bounds
  children?: Node[]
}
interface Driver {
  hierarchy: () => Promise<Node>
  takeScreenshot: (options: { path: string }) => Promise<unknown>
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (target: { text: string } | { id: string }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: {
    device: string
    platform: 'ios'
    appId: string
    teamId?: string
  }) => Promise<Driver>
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const device = required('TS_STREAM_IOS_UDID')
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const email = required('TS_STREAM_EMAIL')
const game = required('TS_STREAM_GAME')
const afterE15 = process.env.TS_STREAM_AFTER_E15 === '1'
const uploadFile = afterE15 ? '' : required('TS_STREAM_UPLOAD_FILE')
const angle = process.env.TS_STREAM_ANGLE ?? 'Home Plate'
const secondAngle = process.env.TS_STREAM_SECOND_ANGLE ?? 'First Base'
const model = process.env.TS_STREAM_DEVICE_MODEL ?? 'iPhone 13 Pro'
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const APP = 'app.teamstation.app'
/** The phone this script poses as. */
const DEVICE_ID = '00000000-0000-4000-8000-0000000000e1'
const TITLE = 'Upload your recording'
const describe = (name: string): string =>
  `${name} on ${model} — provide a higher-quality copy for future viewing.`
const DOT = 'notification-pending-dot'
/** A Pending reminder card: its body reads the title, then the description. */
const card =
  (name: string) =>
  (node: Node): boolean =>
    node.text === `${TITLE}. ${describe(name)}`

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const started = Date.now()
const say = (line: string): void => {
  console.log(
    `${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(1)}s ${line}`
  )
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** The newest match of `pattern` in the server's log, after `offset` characters. */
async function fromServerLog(pattern: RegExp, offset: number): Promise<string> {
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const match = pattern.exec(
      (await readFile(serverLog, 'utf8')).slice(offset)
    )
    if (match?.[1] != null) return match[1]
    await sleep(300)
  }
  throw new Error(`Nothing matching ${String(pattern)} in the server log`)
}

const request = async (
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<Response> =>
  await fetch(`${api}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token == null ? {} : { authorization: `Bearer ${token}` })
    },
    body: body == null ? undefined : JSON.stringify(body)
  })

/** Asks for a sign-in mail; the local server logs its code and link instead. */
async function askToSignIn(): Promise<{ code: string; link: string }> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await request('POST', '/auth/email-code', { email })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = await fromServerLog(
    new RegExp(`sign-in code for ${escaped}: (\\d{6})`),
    offset
  )
  const link = await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
  return { code, link }
}

/** A session for the test's own API calls: `TS_STREAM_TOKEN`, or a fresh sign-in. */
async function apiToken(): Promise<string> {
  const given = process.env.TS_STREAM_TOKEN
  if (given != null && given !== '') return given
  const { code } = await askToSignIn()
  const verified = await request('POST', '/auth/email-code/verify', {
    email,
    code
  })
  assert.equal(verified.status, 200, 'the sign-in code was accepted')
  return ((await verified.json()) as { token: string }).token
}

interface StreamRow {
  id: string
  label: string
  deviceId?: string | null
  localRecording?: string
}
interface Reminder {
  requestId: string
  type: string
  description: string
  status?: string
  liveStreamId?: string
}

/** Every pending notification of this person, or with `history` every settled one. */
async function pending(token: string, history = false): Promise<Reminder[]> {
  const found: Reminder[] = []
  let cursor: string | null = null
  do {
    const query = [
      ...(history ? ['history=1'] : []),
      ...(cursor == null ? [] : [`cursor=${encodeURIComponent(cursor)}`])
    ]
    const answer = await request(
      'GET',
      `/me/notifications${query.length === 0 ? '' : `?${query.join('&')}`}`,
      undefined,
      token
    )
    assert.equal(answer.status, 200, 'the notifications were listed')
    const page = (await answer.json()) as {
      items: Reminder[]
      nextCursor: string | null
    }
    found.push(...page.items)
    cursor = page.nextCursor
  } while (cursor != null)
  return found
}

async function hasPending(token: string): Promise<boolean> {
  const answer = await request(
    'GET',
    '/me/notifications/summary',
    undefined,
    token
  )
  assert.equal(answer.status, 200, 'the summary was read')
  return ((await answer.json()) as { hasPending: boolean }).hasPending
}

/**
 * A fresh stream for `name` on this script's phone, marked recorded, which
 * gives its owner the reminder. An earlier run's stream of the same name is
 * removed first, since a stream that was already recorded reminds nobody.
 */
async function remind(token: string, name: string): Promise<Reminder> {
  const listed = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(listed.status, 200, 'the game’s cameras were listed')
  for (const row of ((await listed.json()) as { mine: StreamRow[] }).mine)
    if (
      row.deviceId === DEVICE_ID &&
      row.label.toLowerCase() === name.toLowerCase()
    ) {
      say(`$ curl -X DELETE …/games/${game}/live-streams/${row.id}`)
      const removed = await request(
        'DELETE',
        `/games/${game}/live-streams/${row.id}`,
        undefined,
        token
      )
      assert(removed.ok, `the earlier ${name} stream was removed`)
    }
  say(
    `$ curl -X POST …/games/${game}/live-streams {label: ${name}, deviceModel: ${model}, recordsLocally: true}`
  )
  const created = await request(
    'POST',
    `/games/${game}/live-streams`,
    {
      label: name,
      deviceId: DEVICE_ID,
      deviceModel: model,
      recordsLocally: true
    },
    token
  )
  assert.equal(created.status, 201, `a fresh ${name} stream`)
  const stream = (await created.json()) as StreamRow
  say(`$ curl -X PATCH …/live-streams/${stream.id} {localRecording: recorded}`)
  const marked = await request(
    'PATCH',
    `/games/${game}/live-streams/${stream.id}`,
    { localRecording: 'recorded' },
    token
  )
  assert(marked.ok, `${name} was marked recorded (${marked.status})`)
  const reminder = (await pending(token)).find(
    item => item.liveStreamId === stream.id
  )
  assert(reminder != null, `${name}'s reminder is pending`)
  assert.equal(reminder.description, describe(name))
  return reminder
}

/** The reminder E15's stop left for `name`: its stream, recorded, still pending. */
async function reminderFromE15(token: string, name: string): Promise<Reminder> {
  const listed = await request(
    'GET',
    `/games/${game}/live-streams`,
    undefined,
    token
  )
  assert.equal(listed.status, 200, 'the game’s cameras were listed')
  const stream = ((await listed.json()) as { mine: StreamRow[] }).mine.find(
    row =>
      row.label.toLowerCase() === name.toLowerCase() &&
      row.localRecording === 'recorded'
  )
  assert(stream != null, `E15 left ${name} recorded and not uploaded`)
  const reminder = (await pending(token)).find(
    item => item.liveStreamId === stream.id
  )
  assert(reminder != null, `${name}'s reminder from E15 is pending`)
  assert.equal(reminder.description, describe(name))
  return reminder
}

/** Uploads `uploadFile` as the whole recording of `liveStreamId`. */
async function uploadRecording(
  token: string,
  liveStreamId: string
): Promise<void> {
  const bytes = await readFile(uploadFile)
  say(
    `$ curl -X POST …/director/uploads {gameId, liveStreamId: ${liveStreamId}, wholeStream: true, sizeBytes: ${bytes.length}}`
  )
  const begun = await request(
    'POST',
    '/director/uploads',
    {
      gameId: game,
      title: 'Recording',
      filename: path.basename(uploadFile),
      sizeBytes: bytes.length,
      startAt: new Date(Date.now() - 60000).toISOString(),
      liveStreamId,
      wholeStream: true
    },
    token
  )
  assert.equal(begun.status, 201, 'the upload began')
  const upload = (await begun.json()) as {
    uploadId: string
    partSize: number
    parts: number
  }
  for (let part = 0; part < upload.parts; part++) {
    say(`$ curl -X PUT …/director/uploads/${upload.uploadId}/parts/${part}`)
    const sent = await fetch(
      `${api}/director/uploads/${upload.uploadId}/parts/${part}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${token}`
        },
        body: bytes.subarray(
          part * upload.partSize,
          (part + 1) * upload.partSize
        )
      }
    )
    assert(sent.ok, `part ${part} was received (${sent.status})`)
  }
  say(`$ curl -X POST …/director/uploads/${upload.uploadId}/finish`)
  const finished = await request(
    'POST',
    `/director/uploads/${upload.uploadId}/finish`,
    {},
    token
  )
  assert.equal(finished.status, 202, 'the upload was finished')
  for (const until = Date.now() + 120000; ;) {
    const state = (await (
      await request(
        'GET',
        `/director/uploads/${upload.uploadId}`,
        undefined,
        token
      )
    ).json()) as { state: string; message: string | null }
    if (state.state === 'ready') return
    assert.notEqual(
      state.state,
      'failed',
      `the upload failed: ${state.message}`
    )
    assert(Date.now() < until, `the upload is still ${state.state}`)
    await sleep(1000)
  }
}

async function main(): Promise<void> {
  const token = await apiToken()
  const results: string[] = []
  const pass = (line: string): void => {
    results.push(`PASS ${line}`)
    say(`PASS ${line}`)
  }

  // Earlier runs' reminders would sit above this run's card and hold the dot.
  // After E15, its own reminder is the one this run reads.
  const keep = afterE15 ? await reminderFromE15(token, angle) : undefined
  for (const item of await pending(token))
    if (item.type === 'recordingUpload' && item.requestId !== keep?.requestId) {
      say(`$ curl -X PUT …/me/notifications/${item.requestId}/dismissed`)
      const settled = await request(
        'PUT',
        `/me/notifications/${item.requestId}/dismissed`,
        {},
        token
      )
      assert.equal(settled.status, 204, 'an earlier reminder was dismissed')
    }
  const first = keep ?? (await remind(token, angle))
  assert.equal(await hasPending(token), true, 'the summary says pending')

  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: true })
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId: APP,
    ...(teamId == null ? {} : { teamId })
  })
  if (artifacts != null) await mkdir(artifacts, { recursive: true })

  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const find = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<Node | undefined> => {
    for (const until = Date.now() + wait; ;) {
      const found = (await nodes()).find(
        node => test(node) && node.bounds != null && node.bounds.width > 0
      )
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(400)
    }
  }
  const gone = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<boolean> => {
    for (const until = Date.now() + wait; ;) {
      if (
        !(await nodes()).some(
          node => test(node) && node.bounds != null && node.bounds.width > 0
        )
      )
        return true
      if (Date.now() > until) return false
      await sleep(400)
    }
  }
  const byText = (text: string) => (node: Node) => node.text === text
  const byId = (id: string) => (node: Node) => node.id === id
  const tap = async (
    target: { text: string } | { id: string }
  ): Promise<void> => {
    say(`$ tapOn ${'text' in target ? target.text : `#${target.id}`}`)
    await m.tapOn(target)
  }
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    say(`$ takeScreenshot ${name}`)
    await m.takeScreenshot({ path: path.join(artifacts, name) })
  }
  /** Lists Pending afresh: a section change reloads it. */
  const reloadPending = async (): Promise<void> => {
    await tap({ text: 'Sent' })
    await sleep(800)
    await tap({ text: 'Pending' })
    await sleep(1500)
  }

  try {
    say('$ launchApp')
    await m.launchApp({ appId: APP, stopApp: true })
    // The first launch waits on Metro's bundle; the shell is ready once it
    // shows either the sign-in card or the bell.
    const ready = await find(
      node =>
        node.text === 'Sign in to TeamStation' || node.id === 'Notifications',
      60000
    )
    if (ready?.id !== 'Notifications') {
      const { link } = await askToSignIn()
      say('$ openLink teamstation://signin/<token>')
      await m.openLink({ link: `teamstation://signin/${link}` })
      await sleep(3000)
      if ((await find(byId('signInLinkSignIn'), 3000)) != null)
        await tap({ id: 'signInLinkSignIn' })
      assert(
        await gone(byText('Sign in to TeamStation'), 20000),
        'the app signed in'
      )
    }

    // 1. The dot, then the bell.
    say(`$ assertVisible #${DOT}`)
    assert((await find(byId(DOT), 20000)) != null, 'the pending dot shows')
    pass('1 the header’s pending dot shows')
    await tap({ id: 'Notifications' })
    await tap({ text: 'Pending' })

    // 2. The card.
    say(`$ assertVisible "${TITLE}. ${describe(angle)}"`)
    assert(
      (await find(card(angle), 15000)) != null,
      'the reminder is listed, naming the angle and the phone'
    )
    assert((await find(byText('Reminder'), 5000)) != null, 'labelled Reminder')
    assert(
      await gone(byText('Needs your approval'), 1000),
      'nothing here asks for an approval'
    )
    await sleep(1000)
    await shot('notifications-pending-after.png')
    pass('2 the card reads "Upload your recording" and names the angle')

    // 3. Upload opens the game's Videos tab.
    await tap({ text: 'Upload' })
    say('$ assertVisible Box score')
    assert((await find(byText('Box score'), 20000)) != null, 'the game opened')
    say('$ assertVisible Record Video')
    assert(
      (await find(byText('Record Video'), 10000)) != null,
      'on its Videos tab, where Upload Recording is'
    )
    pass('3 Upload opens the game on its Videos tab')
    await tap({ id: 'Back' })
    assert((await find(card(angle), 10000)) != null, 'back on Pending')

    // 4. Dismiss.
    await tap({ text: 'Dismiss' })
    say(`$ assertNotVisible "${TITLE}. ${describe(angle)}"`)
    assert(await gone(card(angle), 10000), 'the card is gone after Dismiss')
    const settled = (await pending(token)).find(
      item => item.requestId === first.requestId
    )
    assert.equal(settled, undefined, 'the server no longer lists it pending')
    const stillPending = await hasPending(token)
    if (stillPending) {
      assert((await find(byId(DOT), 5000)) != null, 'the dot stays')
      pass('4 Dismiss removes the card; the dot stays for something else')
    } else {
      say(`$ assertNotVisible #${DOT}`)
      assert(await gone(byId(DOT), 10000), 'the dot clears')
      pass('4 Dismiss removes the card and clears the dot')
    }

    // 5. History, then a reminder.
    await tap({ text: 'History' })
    await sleep(1500)
    await tap({ text: TITLE })
    say('$ assertVisible Upload')
    assert((await find(byText('Upload'), 10000)) != null, 'Upload is offered')
    assert(await gone(byText('Accept invitation'), 1000), 'nothing to accept')
    assert(await gone(byText('Decline invitation'), 1000), 'nothing to decline')
    await tap({ id: 'Back' })
    say(`$ openLink teamstation://notifications/${first.requestId}`)
    await m.openLink({
      link: `teamstation://notifications/${first.requestId}`
    })
    assert(
      (await find(byText(describe(angle)), 15000)) != null,
      'this run’s reminder opened'
    )
    assert((await find(byText('Upload'), 5000)) != null, 'with Upload')
    assert(
      await gone(byText('Accept invitation'), 1000),
      'and nothing to accept'
    )
    pass('5 a reminder’s detail from History shows Upload and no Accept')

    // 6. After E16, the Pixel's reminder was settled by its upload, with
    // nothing pressed.
    if (afterE15) {
      const settledByUpload = (await pending(token, true)).find(
        item =>
          item.type === 'recordingUpload' &&
          item.description.startsWith(`${secondAngle} on `)
      )
      assert(
        settledByUpload != null,
        `${secondAngle}'s reminder from E15 is in History`
      )
      assert.equal(settledByUpload.status, 'accepted', 'settled')
      assert.equal(
        (await pending(token)).find(
          item => item.requestId === settledByUpload.requestId
        ),
        undefined,
        `${secondAngle}'s reminder is not pending`
      )
      await tap({ id: 'Notifications' })
      await reloadPending()
      say(`$ assertNotVisible "${TITLE}. ${secondAngle} on …"`)
      assert(
        await gone(
          node =>
            node.text?.startsWith(`${TITLE}. ${secondAngle} on `) === true,
          5000
        ),
        `no ${secondAngle} card in Pending`
      )
      pass(
        `6 ${secondAngle}'s reminder (“${settledByUpload.description}”) cleared by itself after E16's upload`
      )
    } else {
      // 6. An upload naming the stream clears its reminder by itself.
      const second = await remind(token, secondAngle)
      await tap({ id: 'Notifications' })
      await reloadPending()
      say(`$ assertVisible "${TITLE}. ${describe(secondAngle)}"`)
      assert(
        (await find(card(secondAngle), 15000)) != null,
        'the second reminder is listed'
      )
      assert(second.liveStreamId != null, 'the reminder names its stream')
      await uploadRecording(token, second.liveStreamId)
      assert.equal(
        (await pending(token)).find(
          item => item.requestId === second.requestId
        ),
        undefined,
        'the server cleared the second reminder'
      )
      await reloadPending()
      say(`$ assertNotVisible "${TITLE}. ${describe(secondAngle)}"`)
      assert(
        await gone(card(secondAngle), 10000),
        'the card went with nothing pressed'
      )
      pass('6 an upload naming the stream clears its reminder by itself')
    }
  } finally {
    await m.detach().catch(() => undefined)
  }
  for (const line of results) say(line)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
