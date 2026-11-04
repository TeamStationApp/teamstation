/**
 * The chat2 harness's disposable scene: synthetic people and the encrypted
 * history its scenarios read, made through the real authorized API by
 * provider engines, plus the private settings of its fixture-control proxy.
 * `assembleChat2Fixtures` later merges the per-surface parts recorded on the
 * actual devices (bindings, variants, picker steps, legacy baselines) into
 * one `Chat2Fixture` per surface. Nothing here resets an identity.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import type { MessageView } from '../src/app/chat/engine/apply'
import type { ChatEngine } from '../src/app/chat/engine/engine'
import type { TeamStationClient } from '../src/common/api'
import { makeId } from '../src/common/ids'
import { addEmail } from '../src/server/auth/emails'
import { hashPassword } from '../src/server/auth/passwords'
import { drainDirty } from '../src/server/chat/reconciler'
import type { Database } from '../src/server/db/database'
import { mintUserId } from '../src/server/users/mintUserId'
import type { SeedTablePerson } from '../src/test/chatSeedTable'
import { insertFixtureUsers } from '../src/test/insertFixtureUsers'

export const CHAT2_MAIN_SURFACES = [
  'web-wide',
  'web-narrow',
  'web-touch',
  'ios',
  'android'
] as const

interface Provider {
  client: TeamStationClient
  engine: ChatEngine
  keyFile: string
  sessionFile: string
}

interface Person {
  userId: string
  email: string
  password: string
  name: string
}

export interface Chat2SceneInput {
  ownershipId: string
  out: string
  apiUrl: string
  webUrl: string
  mediaUrl: string
  databaseUrl: string
  applicationSource: string
  ffmpeg: string
  db: Kysely<Database>
  people: Record<string, SeedTablePerson>
  provider: (person: Person, key: string) => Promise<Provider>
}

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx'
  })
}

function message(
  view: MessageView | undefined,
  authorId: string
): { id: string; seq: number; body: string; authorId: string } {
  assert(view?.seq != null, 'A verified synthetic post is required')
  return { id: view.id, seq: view.seq, body: view.body ?? '', authorId }
}

/** The viewer of each main surface, and the E11 pair. */
const VIEWERS: Record<string, string> = {
  'web-wide': 'Hs',
  'web-narrow': 'Hk',
  'web-touch': 'Ha',
  'web-320': 'Ha',
  ios: 'A',
  android: 'B'
}

export async function prepareChat2Scene(
  input: Chat2SceneInput
): Promise<string> {
  const { db, out, people } = input
  const team = async (name: string): Promise<string> =>
    (
      await db
        .selectFrom('teams')
        .select(['id'])
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id
  const hawks = await team('Hawks')
  const eagles = await team('Eagles')

  // Synthetic people the seed lacks: probes, two members who share a name,
  // and members with legacy (historical numeric) ids for I1/I2.
  const created: Record<string, Person> = {}
  const add = async (
    key: string,
    firstName: string,
    lastName: string,
    teamId: string,
    legacy?: number
  ): Promise<void> => {
    const password = randomBytes(24).toString('base64url')
    const email = `chat2-${key.toLowerCase()}-${input.ownershipId}@example.test`
    const name = firstName + ' ' + lastName
    const values = {
      display_name: name,
      first_name: firstName,
      last_name: lastName,
      password_hash: await hashPassword(password),
      login_enabled: true,
      is_admin: false,
      onboarding_step: 'complete' as const,
      onboarding_completed_at: new Date(),
      birth_year: null,
      birth_month: null
    }
    let userId: string
    if (legacy != null) {
      await insertFixtureUsers(db, [{ id: legacy, email, ...values }])
      userId = (
        await db
          .selectFrom('user_emails')
          .select(['user_id'])
          .where('email', '=', email)
          .executeTakeFirstOrThrow()
      ).user_id
    } else {
      userId = mintUserId()
      await db
        .insertInto('users')
        .values({ id: userId, ...values })
        .execute()
      const added = await addEmail(db, userId, email, {
        isPrimary: true,
        source: 'manual',
        verifiedAt: new Date()
      })
      assert(added.heldBy == null, 'Synthetic address already taken')
    }
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member',
        is_player: false
      })
      .execute()
    created[key] = { userId, email, password, name }
  }
  await add('SwitchProbe', 'Cal', 'Ripken', eagles)
  await add('FormerProbe', 'Tony', 'Gwynn', eagles)
  await add('PhotoProbe', 'Mike', 'Trout', eagles)
  await add('SameNameOne', 'Willie', 'Mays', hawks)
  await add('SameNameTwo', 'Willie', 'Mays', hawks)
  for (const [index, surface] of CHAT2_MAIN_SURFACES.entries())
    await add(
      'Legacy' + surface.replace(/-/g, ''),
      ['Hank', 'Jackie', 'Roberto', 'Ernie', 'Satchel'][index],
      ['Greenberg', 'Robinson', 'Clemente', 'Banks', 'Paige'][index],
      hawks,
      910001 + index
    )
  await add('LegacyPeer', 'Lou', 'Gehrig', hawks, 910101)
  for (const [index, surface] of CHAT2_MAIN_SURFACES.entries())
    await add(
      'Locked' + surface.replace(/-/g, ''),
      ['Rod', 'Ozzie', 'Tom', 'Greg', 'Randy'][index],
      ['Carew', 'Smith', 'Seaver', 'Maddux', 'Johnson'][index],
      eagles
    )
  await drainDirty(db, new Date())
  const everyone: Record<string, Person> = {
    ...Object.fromEntries(
      Object.entries(people).map(([key, person]) => [key, { ...person }])
    ),
    ...created
  }

  const providers: Record<string, Provider> = {}
  const get = async (key: string): Promise<Provider> => {
    providers[key] ??= await input.provider(everyone[key], key)
    return providers[key]
  }
  const opened = new Set<string>()
  const engine = async (key: string, id: string): Promise<ChatEngine> => {
    const provider = await get(key)
    if (!opened.has(key + id)) {
      await provider.engine.refresh()
      await provider.engine.open(id)
      opened.add(key + id)
    }
    return provider.engine
  }
  const post = async (
    key: string,
    id: string,
    body: string,
    options: { quoteId?: string; mentions?: string[] } = {}
  ): Promise<ReturnType<typeof message>> =>
    message(
      await (await engine(key, id)).sendText(id, body, options),
      everyone[key].userId
    )
  const userId = (key: string): string => everyone[key].userId

  // The synthetic photo: magenta and green tiles the harness recognizes.
  const photo = join(out, 'chat2-photo.png')
  execFileSync(
    input.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0xE020E0:s=96x192',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x20E040:s=96x192',
      '-filter_complex',
      'hstack',
      '-frames:v',
      '1',
      photo
    ],
    { stdio: 'ignore' }
  )
  const photoBytes = readFileSync(photo)
  const photoFile = {
    bytes: photoBytes,
    contentType: 'image/png',
    fileName: 'Synthetic practice tiles.png',
    width: 192,
    height: 192
  }

  try {
    const peer = 'Hc'
    const group = (await (await get(peer)).client.chatConversations()).find(
      row => row.title === 'Hawks Members'
    )
    assert(group != null, 'The Hawks Members chat is required')
    // Every viewer, the readers and probes start with a provider identity,
    // so the UI's Link this device is approved through it.
    for (const key of [
      ...new Set(Object.values(VIEWERS)),
      'N',
      'Ea',
      'Ec',
      'SwitchProbe',
      'LegacyPeer',
      ...CHAT2_MAIN_SURFACES.map(
        surface => 'Legacy' + surface.replace(/-/g, '')
      )
    ])
      await get(key)

    // The group's history: an oldest post more than a page above the end.
    const oldest = await post(peer, group.id, 'The first practice note.')
    for (let index = 0; index < 120; index++)
      await post(
        index % 2 === 0 ? 'Hs' : peer,
        group.id,
        `Practice thread note ${index + 1}.`
      )
    const target = await post(
      peer,
      group.id,
      'Bring a water bottle to the next practice.'
    )
    const long = await post(
      peer,
      group.id,
      'Check the space and equipment before each turn. '.repeat(32).trim()
    )
    const file = message(
      await (
        await engine(peer, group.id)
      ).attach(group.id, [photoFile], 'Synthetic encrypted file post'),
      userId(peer)
    )
    const outgoing: Record<string, ReturnType<typeof message>> = {}
    for (const key of new Set(Object.values(VIEWERS))) {
      outgoing[key] = await post(key, group.id, `An own note from ${key}.`)
      await post(peer, group.id, 'The earlier practice note is confirmed.', {
        quoteId: outgoing[key].id
      })
    }
    const cursors: Record<string, number> = {}
    const groupSeq = (await (await get(peer)).client.chatConversations()).find(
      row => row.id === group.id
    )?.lastSeq
    assert(groupSeq != null)
    for (const key of new Set(Object.values(VIEWERS))) {
      const viewer = await engine(key, group.id)
      await viewer.pinMessage(group.id, target.id, true)
      await viewer.pinMessage(group.id, long.id, true)
      await (await get(key)).client.markChatRead(group.id, groupSeq)
      cursors[userId(key) + ':' + group.id] = groupSeq
    }

    // Per viewer: a DM with the peer, an empty conversation, an E10 loop.
    const dms: Record<string, { id: string; title: string }> = {}
    const empties: Record<string, { id: string; title: string }> = {}
    const loops: Record<string, unknown> = {}
    for (const key of new Set(Object.values(VIEWERS))) {
      const client = (await get(key)).client
      const dm = await client.createDm([userId(peer)])
      await post(key, dm.id, 'A direct practice question.')
      dms[key] = { id: dm.id, title: everyone[peer].name }
      const empty = await client.createDm([userId('C'), userId('N')])
      empties[key] = { id: empty.id, title: 'Empty planning group' }
      const loop = await client.createDm([userId(peer), userId('D')])
      const own = await post(key, loop.id, 'The loop plan original.')
      let anchor: ReturnType<typeof message> | undefined
      let last: ReturnType<typeof message> | undefined
      for (let index = 0; index < 8; index++) {
        last = await post(
          peer,
          loop.id,
          `Reader padding ${index + 1}. ` +
            'Keep space clear before each turn. '.repeat(24)
        )
        if (index === 3) anchor = last
      }
      assert(anchor != null && last != null)
      await client.markChatRead(loop.id, last.seq)
      cursors[userId(key) + ':' + loop.id] = last.seq
      loops[userId(key)] = {
        viewerId: userId(key),
        viewerName: (await client.chatMembers(loop.id)).find(
          member => member.userId === userId(key)
        )?.shortName,
        conversationId: loop.id,
        readerAnchor: anchor,
        ownOriginal: own,
        peer: {
          userId: userId(peer),
          email: everyone[peer].email,
          password: everyone[peer].password,
          keyFile: providers[peer].keyFile
        }
      }
    }

    // Read-only: the season announcements, which a parent may only read.
    const announcements = (
      await (await get('N')).client.chatConversations()
    ).find(row => row.kind === 'seasonAnnouncements')
    assert(announcements != null && !announcements.canPost)

    // Former, switch, empty attention and the avatar probes.
    const ec = 'Ec'
    const formerDm = await (
      await get(ec)
    ).client.createDm([userId('FormerProbe')])
    await post(ec, formerDm.id, 'A disposable former-member note.')
    await (await get('FormerProbe')).client.leaveDm(formerDm.id)
    const switchDm = await (
      await get(ec)
    ).client.createDm([userId('SwitchProbe')])
    await post(ec, switchDm.id, 'The switch workspace note.')
    const attentionEmpty = await (
      await get(ec)
    ).client.createDm([userId('Ea'), userId('SwitchProbe')])
    await (
      await get('PhotoProbe')
    ).client.setAccountPhoto({
      contentType: 'image/png',
      base64: photoBytes.toString('base64')
    })
    await db
      .updateTable('users')
      .set({
        avatar_path: `images/people/synthetic-broken-${userId('FormerProbe')}/missing`,
        avatar_source: 'upload'
      })
      .where('id', '=', userId('FormerProbe'))
      .execute()
    const switching = (await get('SwitchProbe')).client
    const photoDm = await switching.createDm([userId('PhotoProbe')])
    const brokenDm = await switching.createDm([userId('FormerProbe')])
    const initialsDm = await switching.createDm([userId(ec)])
    const initials = (name: string): string =>
      name
        .split(' ')
        .map(part => part[0])
        .slice(0, 2)
        .join('')

    // E11's cold history: an own original far above the read cursor, a
    // hidden file, a full page of operations only, then 221 targets.
    const stressRoom = await (
      await get('Ea')
    ).client.createDm([userId(ec), userId('PhotoProbe')])
    const ownOriginal = await post(
      'Ea',
      stressRoom.id,
      'An own original outside the cold page.'
    )
    let hidden: ReturnType<typeof message> | undefined
    let hiddenAttachment = ''
    let anchor: ReturnType<typeof message> | undefined
    for (let index = 2; index <= 200; index++) {
      if (index === 20) {
        const view = await (
          await engine('Ea', stressRoom.id)
        ).attach(stressRoom.id, [photoFile], 'A hidden historical image')
        hidden = message(view, userId('Ea'))
        hiddenAttachment = view?.attachments?.[0]?.id ?? ''
        anchor = hidden
      } else
        anchor = await post(
          'Ea',
          stressRoom.id,
          `Own neutral history ${index}.`
        )
    }
    assert(hidden != null && anchor != null && hiddenAttachment !== '')
    for (let index = 0; index < 20; index++)
      await post('Ea', stressRoom.id, `Own unread spacer ${index}.`)
    const sender = await engine(ec, stressRoom.id)
    for (let index = 0; index < 200; index++)
      await sender.react(stressRoom.id, ownOriginal.id, '👍', index % 2 === 1)
    const targets: string[] = []
    for (let index = 0; index < 220; index++)
      targets.push(
        (
          await post(ec, stressRoom.id, `Unread mention ${index + 1}.`, {
            mentions: [userId('Ea')]
          })
        ).id
      )
    const firstUnreadReply = await post(
      ec,
      stressRoom.id,
      'An unread reply to the old own original.',
      { quoteId: ownOriginal.id }
    )
    const neutralTail = await post(
      'Ea',
      stressRoom.id,
      'Keep the reader here while earlier attention is verified. '.repeat(60)
    )
    await (
      await engine('Ea', stressRoom.id)
    ).pinMessage(stressRoom.id, anchor.id, true)
    await (await get('Ea')).client.markChatRead(stressRoom.id, anchor.seq)
    cursors[userId('Ea') + ':' + stressRoom.id] = anchor.seq

    // One never-enrolled probe per surface, in a DM with Ec only.
    const generation = 'g' + Date.now().toString(36)
    const lockedCases: Record<string, unknown> = {}
    for (const surface of CHAT2_MAIN_SURFACES) {
      const key = 'Locked' + surface.replace(/-/g, '')
      const dm = await (await get(ec)).client.createDm([userId(key)])
      lockedCases[surface] = {
        viewer: key,
        conversation: { id: dm.id, title: everyone[key].name },
        message: await post(ec, dm.id, 'An old post before first enrollment.'),
        generation
      }
    }

    const members = (await (await get(peer)).client.chatMembers(group.id)).map(
      member => ({
        userId: member.userId,
        name: member.shortName,
        role: member.label,
        search: member.shortName.split(' ')[0]
      })
    )
    const duplicate = (name: string): boolean =>
      members.filter(member => member.name === name).length > 1
    members.sort(
      (a, b) => Number(duplicate(b.name)) - Number(duplicate(a.name))
    )

    const actors = Object.fromEntries(
      Object.entries(everyone).map(([key, person]) => [
        key,
        {
          userId: person.userId,
          email: person.email,
          password: person.password,
          accountLabel: 'Account, ' + person.name,
          ...(providers[key] == null
            ? {}
            : {
                provider: {
                  keyFile: providers[key].keyFile,
                  sessionFile: providers[key].sessionFile
                }
              })
        }
      ])
    )
    const scene = {
      schema: 1,
      synthetic: true,
      disposable: true,
      localOnly: true,
      ownershipId: input.ownershipId,
      appId: 'app.teamstation.app',
      scheme: 'teamstation',
      apiUrl: input.apiUrl,
      webUrl: input.webUrl,
      actors,
      viewers: VIEWERS,
      scenarioViewers: { E11: 'Ea' },
      scenarioPeers: { E11: ec },
      peer,
      switchActor: 'SwitchProbe',
      formerActor: 'FormerProbe',
      readOnlyViewer: 'N',
      lockedCases,
      controls: {
        attentionLoading: 'chat-attention-loading',
        attentionRetry: 'chat-attention-retry',
        jumpRetry: 'chat-history-jump-retry'
      },
      authorization: {
        playerIds: [userId('P')],
        acceptedAdult: userId('G1'),
        asker: 'Hc'
      },
      avatarProbe: {
        viewer: 'SwitchProbe',
        photoConversation: { id: photoDm.id, title: created.PhotoProbe.name },
        initialsConversation: { id: initialsDm.id, title: everyone[ec].name },
        brokenConversation: {
          id: brokenDm.id,
          title: created.FormerProbe.name
        },
        initials: initials(everyone[ec].name),
        brokenInitials: initials(created.FormerProbe.name)
      },
      conversations: {
        group: {
          id: group.id,
          title: 'Hawks Members',
          identityLabel: 'Hawks, Team Members'
        },
        readOnly: { id: announcements.id, title: announcements.title ?? '' },
        former: { id: formerDm.id, title: created.FormerProbe.name },
        switch: { id: switchDm.id, title: created.SwitchProbe.name },
        attentionEmpty: { id: attentionEmpty.id, title: 'Empty attention' },
        attentionStress: { id: stressRoom.id, title: 'Cold attention' }
      },
      perViewer: { dms, empties, outgoing },
      messages: { target, long, incoming: target, file, oldest },
      members,
      files: {
        synthetic: true,
        photo,
        label: photoFile.fileName,
        sha256: createHash('sha256').update(photoBytes).digest('hex')
      },
      historyStress: {
        viewer: 'Ea',
        sender: ec,
        readCursor: anchor.seq,
        ownOriginal,
        firstUnreadReply,
        readerAnchor: anchor,
        neutralTail,
        expectedCount: 221,
        hiddenFile: {
          message: hidden,
          attachmentId: hiddenAttachment,
          objectPath: `/recovery/chat/${stressRoom.id}/${hiddenAttachment}`
        },
        targetIds: [...targets, firstUnreadReply.id],
        operationsOnlyBefore: 0,
        emptyBefore: 0
      },
      cleanupServices: true
    }
    privateJson(join(out, 'chat2-scene.json'), scene)
    privateJson(join(out, 'chat2-proxy-settings.json'), {
      disposable: true,
      ownershipId: input.ownershipId,
      applicationSource: input.applicationSource,
      apiUpstream: new URL(input.apiUrl).origin,
      mediaUpstream: input.mediaUrl,
      databaseUrl: input.databaseUrl,
      readCursors: cursors,
      claimsFile: join(out, 'chat2-locked-claims.json'),
      loops
    })
    return join(out, 'chat2-scene.json')
  } finally {
    for (const provider of Object.values(providers)) provider.engine.stop()
    await Promise.all(
      Object.values(providers).map(async provider => {
        await provider.engine.idle()
      })
    )
  }
}

/**
 * One fixture per surface: the scene, with that surface's own outgoing post,
 * DM and empty chat, and the parts recorded for it on the actual devices.
 */
export function assembleChat2Fixtures(input: {
  out: string
  parts: {
    bindings: Record<string, unknown>
    devices: Record<string, unknown>
    browser: Record<string, unknown>
    allowedOrigins: string[]
    variants?: Record<string, unknown>
    nativePicker?: Record<string, unknown>
    identityCompatibility?: Record<string, unknown>
    afterArchive?: string
    matrix?: unknown[]
  }
}): Record<string, string> {
  const scene = JSON.parse(
    readFileSync(join(input.out, 'chat2-scene.json'), 'utf8')
  ) as Record<string, any>
  const files: Record<string, string> = {}
  for (const surface of [...CHAT2_MAIN_SURFACES, 'web-320']) {
    const viewer = scene.viewers[surface] as string
    const { perViewer, ...rest } = scene
    const fixture = {
      ...rest,
      allowedOrigins: input.parts.allowedOrigins,
      conversations: {
        ...scene.conversations,
        dm: perViewer.dms[viewer],
        empty: perViewer.empties[viewer]
      },
      messages: { ...scene.messages, outgoing: perViewer.outgoing[viewer] },
      files: {
        ...scene.files,
        ...(input.parts.nativePicker == null
          ? {}
          : { nativePicker: input.parts.nativePicker })
      },
      bindings: input.parts.bindings,
      devices: input.parts.devices,
      browser: input.parts.browser,
      ...(input.parts.variants == null
        ? {}
        : { variants: input.parts.variants }),
      ...(input.parts.identityCompatibility == null
        ? {}
        : { identityCompatibility: input.parts.identityCompatibility }),
      ...(input.parts.afterArchive == null
        ? {}
        : { afterArchive: input.parts.afterArchive }),
      matrix: input.parts.matrix ?? []
    }
    const path = join(input.out, `chat2-fixture-${surface}.json`)
    if (existsSync(path))
      writeFileSync(path, JSON.stringify(fixture, null, 2), { mode: 0o600 })
    else privateJson(path, fixture)
    files[surface] = path
  }
  return files
}
