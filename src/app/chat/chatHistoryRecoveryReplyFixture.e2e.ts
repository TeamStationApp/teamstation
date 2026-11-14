/** Normal browser enrollment and isolated reply fixtures for recovery regressions. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { executablePath } from 'puppeteer'

import { readSeedTable } from '../../test/chatSeedTable'

interface Device {
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (options: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  assertVisible: (options: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
  screenshot: () => Promise<Uint8Array>
  uploadFile: (options: { css: string; path: string }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: { wait: number }) => Promise<unknown>
}
interface Setup {
  synthetic: true
  source: string
  origin: string
  apiUrl: string
  seedFile: string
  artifacts: string
  protectedConversation: string
  profiles: Record<string, string>
  incoming: string
  small: string
}
let privateErrorFile: string | undefined

/** The enrollment fixture's navigation entry, shared with the sidebar regression. */
export async function openRecoveryChat(
  m: Pick<Device, 'tapOn' | 'assertVisible'> & {
    evalBrowserScript: (options: { script: string }) => Promise<unknown>
  }
): Promise<void> {
  await m.tapOn({
    css: '[role="tab"][aria-label="Chat"], [role="tab"][aria-label="Messages"]'
  })
  // Allow a rendering interval for cold crypto before accessibility polling.
  await m.evalBrowserScript({
    script: 'await new Promise(r=>setTimeout(r,8000));return true'
  })
  await m.assertVisible({
    css: '[data-testid="chat-conversation-list"]',
    timeout: 60000
  })
}

/**
 * Waits until the browser has written the session cookie into the profile
 * on disk: a later run reuses the profile, and the browser writes its
 * cookies only now and then, so one closed too soon is signed out.
 */
async function sessionPersisted(profile: string): Promise<void> {
  const file = join(profile, 'Default', 'Cookies')
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const row = db
          .prepare(
            "select count(*) as n from cookies where name = 'ts_session'"
          )
          .get() as { n: number } | undefined
        if ((row?.n ?? 0) > 0) return
      } finally {
        db.close()
      }
    } catch {
      // Not written yet, or held by the browser: read it again shortly.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('The signed-in session never reached the profile')
}
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', name + ' is required')
  return value
}
async function read<T>(device: Device, script: string): Promise<T> {
  const result = await device.evalBrowserScript({ script })
  return (
    typeof result.data === 'string' ? JSON.parse(result.data) : result.data
  ) as T
}
async function main(): Promise<void> {
  const setup = JSON.parse(
    readFileSync(required('CHAT_RECOVERY_REPLY_SETUP'), 'utf8')
  ) as Setup
  assert.equal(setup.synthetic, true)
  assert.equal(
    setup.source,
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  )
  for (const url of [setup.origin, setup.apiUrl])
    assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  for (const path of [
    setup.seedFile,
    setup.incoming,
    setup.small,
    ...Object.values(setup.profiles)
  ])
    assert(resolve(path).startsWith(resolve(setup.artifacts) + '/'))
  const mode = process.argv[2]
  assert(
    [
      'enroll',
      'incoming',
      'paging-target',
      'followup',
      'entity',
      'host',
      'locked-original',
      'locked-fresh-send',
      'clip'
    ].includes(mode)
  )
  privateErrorFile = join(setup.artifacts, mode + '-setup-error.log')
  const people = readSeedTable(readFileSync(setup.seedFile, 'utf8'))
  const origin = setup.origin.replace(/\/+$/, '')
  const { MaestroD } = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: required('MAESTRO_D_BIN'),
    idleTimeout: 0
  })
  const active = new Set<Device>()
  // A profile key names its seed person, before any `-<role>` suffix.
  const attach = async (key: string): Promise<Device> => {
    const person = people[key.split('-')[0]]
    assert(person?.email.endsWith('@chat.example.com'))
    assert(setup.profiles[key] != null)
    const m = await daemon.attach({
      device: 'recovery-reply-fixture-' + key,
      platform: 'web',
      driver: 'cdp',
      url: origin,
      artifacts: 'none',
      extra: {
        browser: await executablePath(),
        windowSize: '1440x1000',
        userDataDir: setup.profiles[key]
      }
    })
    active.add(m)
    await m.openLink({ link: origin })
    const auth = await read<string | null>(
      m,
      `const r=await fetch(${JSON.stringify(setup.apiUrl + '/auth/me')},{credentials:'include'});return JSON.stringify(r.ok?(await r.json()).id:null)`
    )
    if (auth == null) {
      await m.assertVisible({ text: 'Use a password instead', timeout: 30000 })
      await m.tapOn({ css: 'input[aria-label="E-mail address"]' })
      await m.inputText({ text: person.email })
      await m.tapOn({ text: 'Use a password instead' })
      await m.tapOn({ css: 'input[aria-label="Password"]' })
      await m.inputText({ text: person.password })
      await m.tapOn({ text: 'Sign in' })
    } else
      assert.equal(auth, person.userId, 'The profile belongs to another actor')
    await m.assertVisible({ text: 'Account,', timeout: 30000 })
    await openRecoveryChat(m)
    assert.equal(
      await read(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/auth/me')},{credentials:'include'});if(!r.ok)throw new Error('Fixture session unavailable');return JSON.stringify((await r.json()).id)`
      ),
      person.userId
    )
    return m
  }
  const close = async (m: Device): Promise<void> => {
    await m.detach()
    active.delete(m)
  }
  const save = (path: string, data: object): void => {
    assert(!existsSync(path), 'Do not overwrite an existing fixture receipt')
    writeFileSync(path, JSON.stringify(data, null, 2), {
      flag: 'wx',
      mode: 0o600
    })
  }
  try {
    if (mode === 'enroll') {
      const actors = (process.env.CHAT_RECOVERY_ENROLL ?? 'Hc,Hs,Ha').split(',')
      for (const key of actors) {
        const m = await attach(key)
        await sessionPersisted(setup.profiles[key])
        await close(m)
        console.log('Normal browser enrollment ready: ' + key)
      }
      save(join(setup.artifacts, 'enrollment.json'), {
        source: setup.source,
        actors,
        normalUi: true
      })
      return
    }
    const enrollment = JSON.parse(
      readFileSync(join(setup.artifacts, 'enrollment.json'), 'utf8')
    )
    assert.equal(enrollment.source, setup.source)
    assert.equal(enrollment.normalUi, true)
    if (mode === 'host') {
      // An existing runner that drives a browser its parent attached
      // (entityChats, chat117, chatBlocks) runs while this process owns the
      // browser.
      const [file, scenario] = process.argv.slice(3)
      assert(
        [
          'src/app/chat/entityChats.e2e.ts',
          'src/app/chat/chat117.e2e.ts',
          'src/app/chat/chatBlocks.e2e.ts'
        ].includes(file) && /^[a-z]+$/.test(scenario ?? '')
      )
      const blocks = file === 'src/app/chat/chatBlocks.e2e.ts'
      if (blocks) {
        // chatBlocks also watches a second browser of the blocker: a copy of
        // Hc's closed, enrolled profile, so the same signed-in linked device.
        const second = join(setup.artifacts, 'profiles', 'actor-second')
        if (!existsSync(second))
          cpSync(setup.profiles.Hc, second, { recursive: true })
        setup.profiles['Hc-second'] = second
      }
      await attach('Hc')
      if (blocks) await attach('Hc-second')
      execFileSync(
        process.execPath,
        ['-r', 'sucrase/register', file, scenario],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            MAESTRO_DEVICE: 'recovery-reply-fixture-Hc',
            CHAT117_DEVICE: 'recovery-reply-fixture-Hc',
            CHAT_BLOCKS_SEED: setup.seedFile,
            CHAT_BLOCKS_API: setup.apiUrl,
            CHAT_BLOCKS_WEB: origin,
            CHAT_BLOCKS_STATE: join(setup.artifacts, 'chat-blocks-state'),
            CHAT_BLOCKS_ARTIFACTS: join(setup.artifacts, 'chat-blocks-results'),
            CHAT_BLOCKS_DEVICE: 'recovery-reply-fixture-Hc',
            CHAT_BLOCKS_SECOND_DEVICE: 'recovery-reply-fixture-Hc-second'
          }
        }
      )
      return
    }
    if (mode === 'locked-original' || mode === 'locked-fresh-send') {
      // The locked-history chain: S's original, readable to the retaining
      // peer L; later, S's first post from its reset identity.
      const original = mode === 'locked-original'
      const m = await attach(original ? 'S' : 'S-reset')
      const conversationId = setup.protectedConversation
      await m.openLink({ link: origin + '/chat/' + conversationId })
      await m.assertVisible({
        css: '[data-testid="chat-composer"]',
        timeout: 60000
      })
      const body = original
        ? 'Locked history original ' + Date.now().toString(36)
        : 'Fresh post after reset ' + Date.now().toString(36)
      const before = await read<number>(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/conversations')},{credentials:'include'});return JSON.stringify((await r.json()).find(x=>x.id===${JSON.stringify(conversationId)}).lastSeq)`
      )
      await m.tapOn({ css: '[data-testid="chat-composer"]' })
      await m.inputText({ text: body })
      await m.tapOn({ text: 'Send' })
      const id = await read<string>(
        m,
        `for(let n=0;n<150;n++){const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/conversations/' + conversationId + '/messages?after=')}+${before},{credentials:'include'});const posts=(await r.json()).filter(x=>x.kind==='post');if(posts.length===1&&document.querySelector('[data-testid="chat-message-'+posts[0].id+'"]'))return JSON.stringify(posts[0].id);if(posts.length>1)throw new Error('Exactly one post per Send');await new Promise(r=>setTimeout(r,100))}throw new Error('Locked chain post was not acknowledged')`
      )
      await m.assertVisible({ text: body })
      await close(m)
      if (original) {
        const peer = await attach('L')
        await peer.openLink({ link: origin + '/chat/' + conversationId })
        await peer.assertVisible({ text: body, timeout: 30000 })
        await close(peer)
      }
      save(
        join(
          setup.artifacts,
          original ? 'locked-original.json' : 'locked-fresh-send.json'
        ),
        original
          ? { conversationId, originalId: id, originalBody: body }
          : { conversationId, freshId: id, freshBody: body }
      )
      console.log(
        original
          ? 'S original readable by the retaining peer L'
          : 'Reset S sent a fresh post without any history approval'
      )
      return
    }
    if (mode === 'clip') {
      // A video in the shared chat, attached and sent the normal way.
      const key = required('CHAT_RECOVERY_CLIP_ACTOR')
      const file = required('CHAT_RECOVERY_CLIP_FILE')
      const name = file.slice(file.lastIndexOf('/') + 1)
      const m = await attach(key)
      const conversationId = setup.protectedConversation
      await m.openLink({ link: origin + '/chat/' + conversationId })
      await m.assertVisible({
        css: '[data-testid="chat-composer"]',
        timeout: 60000
      })
      await m.evalBrowserScript({
        script: `window.recoveryClipClick=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){this.style.display='block';return}return window.recoveryClipClick.call(this)};return true`
      })
      await m.tapOn({ text: 'Attach' })
      await m.uploadFile({ css: 'input[type="file"]', path: file })
      await m.assertVisible({ text: 'Remove ' + name, timeout: 30000 })
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: 'Open ' + name, timeout: 120000 })
      await m.evalBrowserScript({
        script: `if(window.recoveryClipClick)HTMLInputElement.prototype.click=window.recoveryClipClick;return true`
      })
      await close(m)
      save(join(setup.artifacts, 'clip.json'), { conversationId, name })
      console.log('Normal encrypted video sent: ' + name)
      return
    }
    const group = mode === 'followup' || mode === 'entity'
    const m = await attach('Hc')
    const candidate = await read<{ shortName: string } | null>(
      m,
      `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/dm-candidates')},{credentials:'include'});if(!r.ok)throw new Error('Candidate list unavailable');return JSON.stringify((await r.json()).find(p=>p.userId===${JSON.stringify(people.Hs.userId)})??null)`
    )
    assert(candidate != null)
    if (group)
      await m.openLink({
        link: origin + '/chat/' + setup.protectedConversation
      })
    else {
      await m.tapOn({ text: 'New message' })
      await m.tapOn({
        css:
          '[role="button"][aria-label=' +
          JSON.stringify('Pick ' + candidate.shortName) +
          ']'
      })
      await m.tapOn({ text: 'Start conversation' })
    }
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 30000
    })
    const conversationId = await read<string>(
      m,
      'return JSON.stringify(location.pathname.split("/")[2])'
    )
    assert(conversationId.startsWith('cnv_'))
    if (group) assert.equal(conversationId, setup.protectedConversation)
    else assert.notEqual(conversationId, setup.protectedConversation)
    const posts = async (): Promise<Array<{ id: string }>> =>
      await read(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/conversations/' + conversationId + '/messages')},{credentials:'include'});if(!r.ok)throw new Error('Fixture posts unavailable');return JSON.stringify((await r.json()).filter(x=>x.kind==='post').map(x=>({id:x.id})))`
      )
    if (mode !== 'entity')
      assert.equal((await posts()).length, 0, 'A fresh isolated DM is required')
    const send = async (body: string): Promise<string> => {
      const before = await posts()
      await m.tapOn({ css: '[data-testid="chat-composer"]' })
      await m.inputText({ text: body })
      await m.tapOn({ text: 'Send' })
      for (let n = 0; n < 120; n++) {
        const added = (await posts()).filter(
          x => !before.some(old => old.id === x.id)
        )
        if (added.length > 0) {
          assert.equal(added.length, 1, 'Exactly one encrypted post per Send')
          await m.assertVisible({
            css: '[data-testid="chat-message-' + added[0].id + '"]',
            timeout: 15000
          })
          await m.assertVisible({ text: body })
          return added[0].id
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Fixture message was not acknowledged')
    }
    if (mode === 'followup') {
      const body = 'Practice update: please bring water and arrive at 5:30.'
      const id = await send(body)
      save(join(setup.artifacts, 'followup-fixture.json'), {
        source: setup.source,
        conversationId,
        originalId: id,
        originalBody: body
      })
      await close(m)
      const peer = await attach('Hs')
      await peer.openLink({ link: origin + '/chat/' + conversationId })
      await peer.assertVisible({ text: body, timeout: 30000 })
      console.log('Follow-up group post readable on both enrolled profiles')
      return
    }
    if (mode === 'entity') {
      // The team's latest post, which its section's chat list previews.
      const body = 'Practice begins at six.'
      const id = await send(body)
      const scopes = await read<
        Array<{ id: string; scope?: { type: string; id: string } }>
      >(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/conversations')},{credentials:'include'});if(!r.ok)throw new Error('Fixture list unavailable');return JSON.stringify((await r.json()).map(x=>({id:x.id,scope:x.scope})))`
      )
      const team = scopes.find(row => row.id === conversationId)?.scope
      const season = scopes.find(row => row.scope?.type === 'season')?.scope
      assert(team?.type === 'team' && season != null)
      save(join(setup.artifacts, 'entity-fixture.json'), {
        source: setup.source,
        conversationId,
        postId: id,
        teams: { hawks: team.id },
        seasonId: season.id
      })
      console.log('Team post ready for its section chat list')
      return
    }
    const earlier = 'Earlier original for incoming reply'
    const originalId = await send(earlier)
    if (mode === 'paging-target') {
      save(setup.small, {
        conversationId,
        originalId,
        originalBody: earlier,
        peerLabel: candidate.shortName
      })
    } else {
      await m.tapOn({ css: '[data-testid="chat-message-' + originalId + '"]' })
      await m.tapOn({
        css:
          '[data-testid="chat-message-' + originalId + '"] [aria-label="Reply"]'
      })
      await m.assertVisible({ text: 'Cancel reply' })
      const targetBody = 'Receiving actor replies to the original'
      const targetId = await send(targetBody)
      await m.assertVisible({
        css:
          '[data-testid="chat-message-' +
          targetId +
          '"] [aria-label=' +
          JSON.stringify('Jump to message from You: ' + earlier) +
          ']'
      })
      save(setup.incoming, {
        conversationId,
        targetId,
        targetBody,
        targetEarlierBody: earlier,
        senderUserId: people.Hs.userId,
        receiverUserId: people.Hc.userId,
        outgoingSenderName: candidate.shortName
      })
    }
    writeFileSync(
      join(setup.artifacts, mode + '-fixture.png'),
      await m.screenshot()
    )
    console.log('Normal encrypted reply fixture ready: ' + mode)
  } finally {
    for (const m of active) await m.detach().catch(() => undefined)
    await daemon.shutdown({ wait: 15000 })
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    // A driver error can echo the last input, including a synthetic password.
    if (privateErrorFile != null)
      writeFileSync(
        privateErrorFile,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        { mode: 0o600 }
      )
    console.error(
      'Reply fixture setup failed; inspect the private runner artifacts.'
    )
    process.exitCode = 1
  })
