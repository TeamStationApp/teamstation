import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { PNG } from 'pngjs'

import { ChatEngine } from '../../../src/app/chat/engine/engine'
import {
  approveLink,
  pendingLinkCode
} from '../../../src/app/chat/engine/links'
import type { OutgoingFile } from '../../../src/app/chat/engine/send'
import {
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../../../src/app/chat/keyRecord'
import { TeamStationClient } from '../../../src/common/api'
import { asUserId } from '../../../src/common/userId'
import type { SeedTablePerson } from '../../../src/test/chatSeedTable'
import { testPasswordKdf } from '../../../src/test/passwordFixtures'
import type { HarnessContext } from '../../core/spec'

interface Account {
  actor: string
  keyFile: string
}

interface Provider {
  person: SeedTablePerson
  engine: ChatEngine
  approve: (code: string, platform: string) => Promise<void>
}

export interface ChatLinkFixture {
  /**
   * The system pickers' public labels for the photo and document
   * `seedPickerMedia` adds to the phone, and its camera's. Absent on the web,
   * where the browser's own file chooser stands in.
   */
  composerPanel?: {
    libraryPhoto: string
    libraryWidth: number
    libraryHeight: number
    documentFolders: string[]
    shutter: string
    acceptPhoto: string
  }
  /** A two-file post by the observer, moved back a week by `messaging-dated`. */
  datedCaptionId?: string
  origin: string
  /** The world's two people, by actor. */
  people: Record<string, SeedTablePerson>
  /** This run's own directory for the chat devices' key records. */
  keysDir: string
  observer: Account
  sender: Account
  conversationId: string
}

/**
 * The `messaging` world: two adults on one team and their direct
 * conversation, seeded on this scenario's stack. Each chat device is this
 * run's own, its keys made the first time a provider starts and kept under
 * the run directory. New test devices link by their displayed code.
 */
export async function fixtureFor(
  ctx: HarnessContext
): Promise<ChatLinkFixture> {
  const world = await ctx.fixture('messaging')
  const keysDir = join(ctx.runDir, 'chat-keys')
  mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  const people: Record<string, SeedTablePerson> = {}
  for (const actor of ['observer', 'sender']) {
    const account = world.accounts[actor]
    assert(account != null, `the messaging world has no ${actor}`)
    people[actor] = {
      userId: asUserId(account.userId),
      name: account.displayName,
      email: account.email,
      password: account.password
    }
  }
  const conversationId = world.ids.conversation
  assert(conversationId != null, 'the messaging world has no conversation')
  return {
    origin: ctx.stack.origin,
    people,
    keysDir,
    observer: { actor: 'observer', keyFile: join(keysDir, 'observer.json') },
    sender: { actor: 'sender', keyFile: join(keysDir, 'sender.json') },
    conversationId
  }
}

/**
 * A two-file caption the observer sent, dated more than a week back by the
 * `messaging-dated` world, for the edit scenario's original.
 */
export async function datedCaption(
  ctx: HarnessContext,
  fixture: ChatLinkFixture,
  author: Provider,
  caption: string
): Promise<string> {
  const files: OutgoingFile[] = [
    {
      bytes: Buffer.from('Practice plan for Thursday.\n'),
      contentType: 'text/plain',
      fileName: 'practice-plan.txt'
    },
    {
      bytes: Buffer.from('Field directions: park behind the dugout.\n'),
      contentType: 'text/plain',
      fileName: 'field-directions.txt'
    }
  ]
  const sent = await author.engine.attach(
    fixture.conversationId,
    files,
    caption
  )
  assert(sent?.mine === true, 'the dated caption must be sent')
  const moved = await ctx.fixture('messaging-dated')
  assert(
    moved.ids.moved.split(',').includes(sent.id),
    'messaging-dated must move the caption back'
  )
  fixture.datedCaptionId = sent.id
  return sent.id
}

// Authentication sessions are each bound to one chat device.
export async function authenticatedActor(
  fixture: ChatLinkFixture,
  account: Account,
  _usage: 'provider' | 'browser'
): Promise<{
  person: SeedTablePerson
  client: TeamStationClient
  token: string
}> {
  const person = fixture.people[account.actor]
  assert(
    person != null && /@(?:[^@]+\.)?example\.(com|test)$/.test(person.email),
    'Expected a synthetic chat account'
  )
  const client = new TeamStationClient({
    baseUrl: fixture.origin + '/api/v1',
    passwordKdf: testPasswordKdf
  })
  const { token } = await client.signInWithPassword(
    person.email,
    person.password
  )
  return { person, client, token }
}

export async function providerFor(
  fixture: ChatLinkFixture,
  account: Account
): Promise<Provider> {
  const { person, client } = await authenticatedActor(
    fixture,
    account,
    'provider'
  )
  const store: ChatKeyStore = {
    exists: async () => existsSync(account.keyFile),
    load: async () =>
      existsSync(account.keyFile)
        ? recordFromJson(readFileSync(account.keyFile, 'utf8'))
        : undefined,
    save: async record => {
      const file = account.keyFile + '.' + randomUUID()
      writeFileSync(file, recordToJson(record), { mode: 0o600, flag: 'wx' })
      renameSync(file, account.keyFile)
    },
    wipe: async () => {
      throw new Error('Expected the synthetic fixture’s own key record')
    }
  }
  const setup = {
    client,
    store,
    userId: person.userId,
    device: { name: 'Chat link test provider', platform: 'web' as const }
  }
  const engine = new ChatEngine(setup)
  try {
    assert.equal(
      await engine.start(),
      'ready',
      'Use the retained provider keys or a fresh synthetic account'
    )
    assert(
      engine.conversations().some(room => room.id === fixture.conversationId),
      'Actor must belong to the synthetic room'
    )
    await engine.open(fixture.conversationId)
    return {
      person,
      engine,
      approve: async (code: string, platform: string) => {
        const requests = (await client.chatLinks()).filter(
          link =>
            link.newDevice.platform === platform &&
            pendingLinkCode(link) === code
        )
        assert.equal(
          requests.length,
          1,
          'Expected only the request shown on the test surface'
        )
        const record = await store.load(person.userId)
        assert(record?.userId === person.userId)
        await approveLink(setup, record, requests[0])
      }
    }
  } catch (error) {
    engine.stop()
    throw error
  }
}

/** The link preview scenario's pages on the stack's pages stand-in. */
export interface PreviewPages {
  /** A titled page with an image, readable from any origin. */
  url: string
  title: string
  /** The same page without CORS headers, which a browser may not read. */
  corsDeniedUrl: string
  /** A page held for ten seconds; a HEAD with its `?probe=` answers 204 while held. */
  pendingUrl: string
}

/** A 96×64 PNG of the club's red, the preview card's thumbnail. */
function cardImage(): string {
  const png = new PNG({ width: 96, height: 64 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200
    png.data[i + 1] = 30
    png.data[i + 2] = 45
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png).toString('base64')
}

/**
 * Scripts the three pages the preview scenario links to, under a path of
 * this run's own, on `ctx.stack.pagesOrigin`.
 */
export async function scriptPreviewPages(
  ctx: HarnessContext
): Promise<PreviewPages> {
  const control = ctx.stack.control
  const origin = ctx.stack.pagesOrigin
  assert(control != null && origin != null, 'the stack has no pages stand-in')
  const base = '/preview/' + randomUUID().slice(0, 8)
  const title = 'Spring practice schedule ' + base.slice(-8)
  const cors = { 'Access-Control-Allow-Origin': '*' }
  const html = (image: string): string =>
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>' +
    title +
    '</title>' +
    '<meta property="og:title" content="' +
    title +
    '">' +
    '<meta property="og:site_name" content="Practice Plans">' +
    '<meta property="og:description" content="Fields, times and who brings the bats.">' +
    '<meta property="og:image" content="' +
    image +
    '">' +
    '</head><body><h1>' +
    title +
    '</h1></body></html>'
  const image = origin + base + '/card.png'
  await control.pages.script({
    [base]: {
      type: 'text/html; charset=utf-8',
      body: html(image),
      headers: cors
    },
    [base + '/card.png']: {
      type: 'image/png',
      body: cardImage(),
      encoding: 'base64',
      headers: cors
    },
    [base + '/denied']: { type: 'text/html; charset=utf-8', body: html(image) },
    [base + '/pending']: {
      type: 'text/html; charset=utf-8',
      body: '<title>Delayed test page</title>',
      holdMs: 10000,
      probe: true
    }
  })
  return {
    url: origin + base,
    title,
    corsDeniedUrl: origin + base + '/denied',
    pendingUrl: origin + base + '/pending'
  }
}

/**
 * Puts the composer scenario's photo and document on the phone with maestro-d
 * `addMedia`, and answers the system pickers' public labels for them and for
 * the camera. The photo is the newest in the library, so the Photos picker's
 * first tile is it (`tapImportedPhoto`).
 */
export async function seedPickerMedia(
  m: { addMedia: (options: { files: string[] }) => Promise<unknown> },
  platform: 'ios' | 'android',
  photo: { path: string; width: number; height: number },
  document: string
): Promise<NonNullable<ChatLinkFixture['composerPanel']>> {
  await m.addMedia({ files: [photo.path, document] })
  return platform === 'ios'
    ? {
        libraryPhoto: '^Photo, .*',
        libraryWidth: photo.width,
        libraryHeight: photo.height,
        documentFolders: ['^Browse$', '^Recents$'],
        shutter: '^(Take Picture|PhotoCapture)$',
        acceptPhoto: '^(Use Photo|Done)$'
      }
    : {
        libraryPhoto: '^Photo taken.*',
        libraryWidth: photo.width,
        libraryHeight: photo.height,
        documentFolders: ['^Show roots$', '^Downloads$'],
        shutter: '^(Shutter|Take photo|Capture)$',
        acceptPhoto: '^(Done|OK|Accept)$'
      }
}
