import { expect } from 'chai'
import { sql } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'

import { pictureCatalog } from '../../common/pictureCatalog'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { afterCommitsSettled, afterRollback, atomic } from '../db/atomic'
import { imageKey, isPublicImagePrefix } from './images'
import { imageUrl } from './imageUrls'
import {
  MISSING_PREFIX,
  namingUploaded,
  releasePictures,
  releaseReplacedPicture,
  republishOwnedImages,
  RETIRED_GRACE_MS,
  RETIRED_PREFIX,
  settlesWithin
} from './republishImages'
import type { SpaceSettings } from './spacesHls'

const OLD = 'images/team/tem_account/abcd1234'

describe('republishing owned pictures', function () {
  this.timeout(60000)
  let h: AccountHarness
  /** Every request the Space was sent, as `<method> <path>`. */
  let sent: string[] = []
  /** The `x-amz-acl` each PUT carried, by path. */
  let acls = new Map<string, string | null>()
  /** Runs before the Space answers a PUT, once. */
  let beforePut: (() => Promise<void>) | undefined
  /** Runs before the Space answers a DELETE, once. */
  let beforeDelete: (() => Promise<void>) | undefined
  const realFetch = globalThis.fetch

  before(async () => {
    h = await accountHarness()
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url
      )
      if (url.origin === new URL(h.space.endpoint).origin) {
        const method = init?.method ?? 'GET'
        sent.push(`${method} ${url.pathname}`)
        if (method === 'PUT') {
          acls.set(
            url.pathname,
            new Headers(init?.headers).get('x-amz-acl') ?? null
          )
          const run = beforePut
          beforePut = undefined
          await run?.()
        }
        if (method === 'DELETE') {
          const run = beforeDelete
          beforeDelete = undefined
          await run?.()
        }
      }
      return await realFetch(input, init)
    }
  })
  after(async () => {
    globalThis.fetch = realFetch
    await h?.close()
  })
  afterEach(async () => {
    sent = []
    acls = new Map()
    h.objects.clear()
    await h.db.updateTable('teams').set({ logo_path: null }).execute()
    await h.db.updateTable('users').set({ avatar_path: null }).execute()
    await h.db.deleteFrom('seasons').execute()
    await h.db
      .deleteFrom('system_settings')
      .where('key', 'like', 'pictures.%')
      .execute()
  })

  const object = (key: string): string => `/${h.space.bucket}/${key}`
  const hold = (prefix: string): void => {
    for (const size of [96, 192] as const)
      h.objects.set(object(imageKey(prefix, size)), Buffer.from(`${size}`))
  }
  const teamLogo = async (): Promise<string | null> =>
    (
      await h.db
        .selectFrom('teams')
        .select('logo_path')
        .where('id', '=', 'tem_account')
        .executeTakeFirstOrThrow()
    ).logo_path
  const avatar = async (id: number): Promise<string | null> =>
    (
      await h.db
        .selectFrom('users')
        .select('avatar_path')
        .where('id', '=', userIdOfGumbo(id))
        .executeTakeFirstOrThrow()
    ).avatar_path
  const remembered = async (under: string): Promise<string[]> =>
    (
      await h.db
        .selectFrom('system_settings')
        .select('key')
        .where('key', 'like', `${under}%`)
        .orderBy('key')
        .execute()
    ).map(({ key }) => key.slice(under.length))
  /** A start a day and a second after now, when a retired prefix is due. */
  const later = (): number => Date.now() + RETIRED_GRACE_MS + 1000

  it('copies an owned old picture to a public key, points the row at it, and deletes the old a day later', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()

    const result = await republishOwnedImages(h.db, h.space)

    expect(result).deep.equals({ moved: 1, skipped: 0, failed: 0 })
    const next = (await teamLogo()) ?? ''
    expect(next).matches(/^images\/team\/[0-9a-f]{32}$/)
    for (const size of [96, 192] as const) {
      const key = object(imageKey(next, size))
      expect(h.objects.get(key)?.toString(), key).equals(`${size}`)
      expect(acls.get(key), key).equals('public-read')
      expect(sent).includes(`PUT ${key}`)
    }
    expect(new URL(imageUrl(h.space, next) ?? '').search).equals('')
    // A process still on the previous build may sign the old prefix: its
    // objects outlive the move, retired, and a start within the day keeps
    // them.
    expect(sent.filter(each => each.startsWith('DELETE'))).deep.equals([])
    expect(await remembered(RETIRED_PREFIX)).deep.equals([OLD])
    sent = []
    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 0,
      skipped: 1,
      failed: 0
    })
    expect(sent).deep.equals([])
    for (const size of [96, 192] as const)
      expect(h.objects.has(object(imageKey(OLD, size)))).equals(true)

    // A start a day later deletes them and forgets the prefix.
    await republishOwnedImages(h.db, h.space, undefined, { now: later })
    for (const size of [96, 192] as const) {
      expect(sent).includes(`DELETE ${object(imageKey(OLD, size))}`)
      expect(h.objects.has(object(imageKey(OLD, size)))).equals(false)
      expect(h.objects.has(object(imageKey(next, size)))).equals(true)
    }
    expect(await remembered(RETIRED_PREFIX)).deep.equals([])
  })

  it('keeps a retired prefix a row names again, and forgets it', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    await republishOwnedImages(h.db, h.space)
    await h.db
      .updateTable('users')
      .set({ avatar_path: OLD })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    sent = []
    await republishOwnedImages(h.db, h.space, undefined, {
      now: later,
      movesAtOnce: 1
    })
    // The user's row was moved again, under a new retirement; nothing of
    // the old prefix was deleted while a row named it.
    expect(sent.filter(each => each.startsWith('DELETE'))).deep.equals([])
    expect(isPublicImagePrefix((await avatar(101)) ?? '')).equals(true)
    expect(await remembered(RETIRED_PREFIX)).deep.equals([OLD])
  })

  it('lets the copy go, and counts the prefix skipped, when an upload replaced the picture while it was copied', async () => {
    hold(OLD)
    const UPLOADED = 'images/team/0123456789abcdef0123456789abcdef'
    hold(UPLOADED)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    // The upload lands between the copy and the rows' update.
    beforePut = async () => {
      await h.db
        .updateTable('teams')
        .set({ logo_path: UPLOADED })
        .where('id', '=', 'tem_account')
        .execute()
    }

    const result = await republishOwnedImages(h.db, h.space)

    expect(result).deep.equals({ moved: 0, skipped: 1, failed: 0 })
    expect(await teamLogo()).equals(UPLOADED)
    const copied = sent
      .filter(each => each.startsWith('PUT '))
      .map(each => each.slice('PUT '.length))
    expect(copied).length(2)
    for (const key of copied) {
      expect(sent).includes(`DELETE ${key}`)
      expect(h.objects.has(key), key).equals(false)
    }
    // Neither the upload's picture nor the old prefix is retired by it.
    for (const size of [96, 192] as const)
      expect(h.objects.has(object(imageKey(UPLOADED, size)))).equals(true)
    expect(await remembered(RETIRED_PREFIX)).deep.equals([])
  })

  it('moves every row that names a prefix in one transaction, or none', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    await h.db
      .updateTable('users')
      .set({ avatar_path: OLD })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    // The teams update, which runs after the users one, is refused.
    await sql`
      create function refuse_logo() returns trigger language plpgsql as
      $$ begin raise exception 'refused logo'; end $$;
      create trigger refuse_logo before update of logo_path on teams
      for each row execute function refuse_logo();
    `.execute(h.db)
    const said: string[] = []
    try {
      expect(
        await republishOwnedImages(h.db, h.space, message => {
          said.push(message)
        })
      ).deep.equals({ moved: 0, skipped: 0, failed: 1 })
    } finally {
      await sql`
        drop trigger refuse_logo on teams; drop function refuse_logo();
      `.execute(h.db)
    }
    expect(await avatar(101)).equals(OLD)
    expect(await teamLogo()).equals(OLD)
    expect(await remembered(RETIRED_PREFIX)).deep.equals([])
    expect(said.join('\n')).contains('refused logo')
  })

  it('copies at most the pool size of prefixes at once, and moves them all', async () => {
    const olds = [0, 1, 2, 3, 4].map(
      n => `images/league/sea_pool${n}/abcd123${n}`
    )
    for (const [n, prefix] of olds.entries()) {
      hold(prefix)
      await h.db
        .insertInto('seasons')
        .values({
          id: `sea_pool${n}`,
          name: `Pool Season ${n}`,
          year: 2027,
          starts_on: '2027-03-01',
          ends_on: '2027-05-31',
          logo_path: prefix
        })
        .execute()
    }
    const recording = globalThis.fetch
    let inFlight = 0
    let most = 0
    globalThis.fetch = async (input, init) => {
      if (init?.method !== 'PUT') return await recording(input, init)
      inFlight += 1
      most = Math.max(most, inFlight)
      try {
        await new Promise(resolve => setTimeout(resolve, 20))
        return await recording(input, init)
      } finally {
        inFlight -= 1
      }
    }
    try {
      expect(
        await republishOwnedImages(h.db, h.space, undefined, { movesAtOnce: 2 })
      ).deep.equals({ moved: 5, skipped: 0, failed: 0 })
    } finally {
      globalThis.fetch = recording
    }
    expect(most).equals(2)
    const logos = await h.db
      .selectFrom('seasons')
      .select('logo_path')
      .where('id', 'like', 'sea_pool%')
      .execute()
    expect(logos).length(5)
    for (const { logo_path: logo } of logos)
      expect(isPublicImagePrefix(logo ?? '')).equals(true)
  })

  it('says whether work settles within a time, and lets it go on', async () => {
    expect(await settlesWithin(Promise.resolve(), 1000)).equals(true)
    expect(await settlesWithin(Promise.reject(new Error('x')), 1000)).equals(
      true
    )
    let finish = (): void => {}
    const slow = new Promise<void>(resolve => {
      finish = resolve
    })
    expect(await settlesWithin(slow, 10)).equals(false)
    finish()
    await slow
  })

  it('moves an old prefix two rows share once, and points both at it', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    await h.db
      .updateTable('users')
      .set({ avatar_path: OLD })
      .where('id', '=', userIdOfGumbo(101))
      .execute()

    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 1,
      skipped: 0,
      failed: 0
    })
    const next = await teamLogo()
    expect(isPublicImagePrefix(next ?? '')).equals(true)
    expect(await avatar(101)).equals(next)
  })

  it('leaves a key the read-only source holds where it is, still signed', async () => {
    const shared = 'images/user/usr_shared/ffff0000'
    const space: SpaceSettings = {
      ...h.space,
      readOnlySource: {
        endpoint: 'https://source.example-ts.test',
        region: 'reader-region',
        bucket: 'library',
        accessKeyId: 'READEREXAMPLE',
        secretAccessKey: 'EXAMPLE',
        keys: [imageKey(shared, 96), imageKey(shared, 192)]
      }
    }
    await h.db
      .updateTable('users')
      .set({ avatar_path: shared })
      .where('id', '=', userIdOfGumbo(102))
      .execute()

    expect(await republishOwnedImages(h.db, space)).deep.equals({
      moved: 0,
      skipped: 1,
      failed: 0
    })
    expect(await avatar(102)).equals(shared)
    expect(sent).deep.equals([])
    const url = new URL(imageUrl(space, shared) ?? '')
    expect(url.hostname).equals('library.source.example-ts.test')
    expect(url.searchParams.has('X-Amz-Signature')).equals(true)
  })

  it('neither copies nor deletes a catalog picture two rows share', async () => {
    const catalog = pictureCatalog[0].prefix
    hold(catalog)
    await h.db
      .updateTable('users')
      .set({ avatar_path: catalog })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    await h.db
      .insertInto('seasons')
      .values({
        id: 'sea_republish',
        name: 'Demo Season',
        year: 2027,
        starts_on: '2027-03-01',
        ends_on: '2027-05-31',
        logo_path: catalog
      })
      .execute()

    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 0,
      skipped: 1,
      failed: 0
    })
    expect(sent).deep.equals([])
    expect(await avatar(101)).equals(catalog)
    expect(
      (
        await h.db
          .selectFrom('seasons')
          .select('logo_path')
          .where('id', '=', 'sea_republish')
          .executeTakeFirstOrThrow()
      ).logo_path
    ).equals(catalog)
    for (const size of [96, 192] as const)
      expect(h.objects.has(object(imageKey(catalog, size)))).equals(true)
  })

  it('skips a prefix that is already public', async () => {
    const already = `images/team/${'ab'.repeat(16)}`
    hold(already)
    await h.db
      .updateTable('teams')
      .set({ logo_path: already })
      .where('id', '=', 'tem_account')
      .execute()

    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 0,
      skipped: 1,
      failed: 0
    })
    expect(sent).deep.equals([])
    expect(await teamLogo()).equals(already)
  })

  it('leaves the row on its old prefix when an object is missing, and does not try it again', async () => {
    // Only the 96 rendition exists, so the 192 copy is refused.
    h.objects.set(object(imageKey(OLD, 96)), Buffer.from('96'))
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    const said: string[] = []

    expect(
      await republishOwnedImages(h.db, h.space, message => {
        said.push(message)
      })
    ).deep.equals({ moved: 0, skipped: 0, failed: 1 })
    expect(await teamLogo()).equals(OLD)
    expect(h.objects.has(object(imageKey(OLD, 96)))).equals(true)
    // The 96 copied before the 192 was refused goes: nothing names it, and
    // it would stay public with nothing to find it (4.harness-review.2).
    expect(
      [...h.objects.keys()].filter(
        key => key.includes('images/team/') && !key.includes(OLD)
      )
    ).deep.equals([])
    expect(said.join('\n')).contains(OLD)
    expect(await remembered(MISSING_PREFIX)).deep.equals([OLD])

    sent = []
    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 0,
      skipped: 1,
      failed: 0
    })
    expect(sent).deep.equals([])
  })

  it('tries a copy the Space failed for a while again at the next start', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    const recording = globalThis.fetch
    globalThis.fetch = async (input, init) =>
      init?.method === 'PUT'
        ? new Response('Unavailable', { status: 503 })
        : await recording(input, init)
    try {
      expect(await republishOwnedImages(h.db, h.space)).deep.equals({
        moved: 0,
        skipped: 0,
        failed: 1
      })
    } finally {
      globalThis.fetch = recording
    }
    expect(await remembered(MISSING_PREFIX)).deep.equals([])
    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 1,
      skipped: 0,
      failed: 0
    })
  })

  it('keeps a retired prefix whose delete fails, says so, and deletes it at the next start', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    expect(await republishOwnedImages(h.db, h.space)).deep.equals({
      moved: 1,
      skipped: 0,
      failed: 0
    })
    const recording = globalThis.fetch
    globalThis.fetch = async (input, init) =>
      init?.method === 'DELETE'
        ? new Response('<Error><Code>InternalError</Code></Error>', {
            status: 500
          })
        : await recording(input, init)
    const said: string[] = []
    try {
      await republishOwnedImages(
        h.db,
        h.space,
        message => {
          said.push(message)
        },
        { now: later }
      )
    } finally {
      globalThis.fetch = recording
    }
    expect(isPublicImagePrefix((await teamLogo()) ?? '')).equals(true)
    expect(said).length(2)
    expect(said[0]).contains(imageKey(OLD, 96))
    expect(await remembered(RETIRED_PREFIX)).deep.equals([OLD])
    await republishOwnedImages(h.db, h.space, undefined, { now: later })
    expect(h.objects.has(object(imageKey(OLD, 96)))).equals(false)
    expect(await remembered(RETIRED_PREFIX)).deep.equals([])
  })

  it('does nothing without a Space', async () => {
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    expect(
      await republishOwnedImages(h.db, { ...h.space, accessKeyId: '' })
    ).deep.equals({ moved: 0, skipped: 0, failed: 0 })
    expect(await teamLogo()).equals(OLD)
  })

  describe('releasing a replaced picture', () => {
    const PUBLIC = `images/team/${'cd'.repeat(16)}`
    const held = (prefix: string): boolean[] =>
      [96, 192].map(size =>
        h.objects.has(object(imageKey(prefix, size as 96 | 192)))
      )

    it('deletes every size of a prefix no row names', async () => {
      hold(PUBLIC)
      expect(await releasePictures(h.db, h.space, [PUBLIC, null])).equals(1)
      expect(held(PUBLIC)).deep.equals([false, false])
      expect(sent).deep.equals([
        `DELETE ${object(imageKey(PUBLIC, 96))}`,
        `DELETE ${object(imageKey(PUBLIC, 192))}`
      ])
    })

    it('keeps a prefix another row still names', async () => {
      hold(PUBLIC)
      await h.db
        .updateTable('users')
        .set({ avatar_path: PUBLIC })
        .where('id', '=', userIdOfGumbo(102))
        .execute()
      expect(await releasePictures(h.db, h.space, [PUBLIC])).equals(0)
      expect(held(PUBLIC)).deep.equals([true, true])
      expect(sent).deep.equals([])
    })

    it('never deletes a catalog picture, a read-only source key, or a prefix of no stored kind', async () => {
      const catalog = pictureCatalog[0].prefix
      const shared = `images/user/${'ef'.repeat(16)}`
      hold(catalog)
      const space: SpaceSettings = {
        ...h.space,
        readOnlySource: {
          endpoint: 'https://source.example-ts.test',
          region: 'reader-region',
          bucket: 'library',
          accessKeyId: 'READEREXAMPLE',
          secretAccessKey: 'EXAMPLE',
          keys: [imageKey(shared, 96), imageKey(shared, 192)]
        }
      }
      expect(
        await releasePictures(h.db, space, [catalog, shared, 'stills/x'])
      ).equals(0)
      expect(held(catalog)).deep.equals([true, true])
      expect(sent).deep.equals([])
    })

    it('logs a delete that fails and goes on', async () => {
      hold(PUBLIC)
      const recording = globalThis.fetch
      globalThis.fetch = async (input, init) =>
        init?.method === 'DELETE'
          ? new Response('<Error/>', { status: 500 })
          : await recording(input, init)
      const said: string[] = []
      try {
        expect(
          await releasePictures(h.db, h.space, [PUBLIC], message => {
            said.push(message)
          })
        ).equals(1)
      } finally {
        globalThis.fetch = recording
      }
      expect(said).length(2)
      expect(said[0]).contains(imageKey(PUBLIC, 96))
    })

    it('does nothing without a Space', async () => {
      hold(PUBLIC)
      expect(
        await releasePictures(h.db, { ...h.space, accessKeyId: '' }, [PUBLIC])
      ).equals(0)
      expect(held(PUBLIC)).deep.equals([true, true])
    })

    it('waits for the commit, and a rolled back write releases nothing', async () => {
      hold(PUBLIC)
      await h.db
        .updateTable('teams')
        .set({ logo_path: PUBLIC })
        .where('id', '=', 'tem_account')
        .execute()
      const replace = async (fail: boolean): Promise<void> => {
        await atomic(h.db, async trx => {
          await trx
            .updateTable('teams')
            .set({ logo_path: null })
            .where('id', '=', 'tem_account')
            .execute()
          await releaseReplacedPicture(trx, h.space, PUBLIC)
          // Still named outside the transaction: nothing is deleted yet.
          expect(held(PUBLIC)).deep.equals([true, true])
          if (fail) throw new Error('rolled back')
        })
      }
      await replace(true).catch(() => undefined)
      expect(await teamLogo()).equals(PUBLIC)
      expect(held(PUBLIC)).deep.equals([true, true])
      await replace(false)
      expect(await teamLogo()).equals(null)
      await afterCommitsSettled()
      expect(held(PUBLIC)).deep.equals([false, false])
    })

    it('answers before a slow release finishes, and still releases once committed', async () => {
      hold(PUBLIC)
      await h.db
        .updateTable('teams')
        .set({ logo_path: PUBLIC })
        .where('id', '=', 'tem_account')
        .execute()
      let finish: () => void = () => undefined
      const slow = new Promise<void>(resolve => {
        finish = resolve
      })
      beforeDelete = async () => {
        await slow
      }
      let answered = false
      await atomic(h.db, async trx => {
        await trx
          .updateTable('teams')
          .set({ logo_path: null })
          .where('id', '=', 'tem_account')
          .execute()
        await releaseReplacedPicture(trx, h.space, PUBLIC)
      })
      answered = true
      // The write answered while the Space still holds the delete.
      expect(answered).equals(true)
      expect(held(PUBLIC)).deep.equals([true, true])
      finish()
      await afterCommitsSettled()
      expect(held(PUBLIC)).deep.equals([false, false])
    })

    it('logs a release that cannot read the rows, and does not throw', async () => {
      const said: unknown[] = []
      const realError = console.error
      console.error = (...args: unknown[]) => {
        said.push(args.join(' '))
      }
      try {
        // No connection at all: the reference check fails.
        const unconnected: unknown = {}
        await releaseReplacedPicture(
          unconnected as typeof h.db,
          h.space,
          PUBLIC
        )
        await afterCommitsSettled()
      } finally {
        console.error = realError
      }
      expect(String(said[0])).contains(`releasing ${PUBLIC}`)
    })

    it('releases at once outside a transaction, and refuses a transaction atomic did not open', async () => {
      hold(PUBLIC)
      await releaseReplacedPicture(h.db, h.space, null)
      await releaseReplacedPicture(h.db, h.space, PUBLIC)
      await afterCommitsSettled()
      expect(held(PUBLIC)).deep.equals([false, false])
      let refused: unknown
      await h.db
        .transaction()
        .execute(async trx => {
          await releaseReplacedPicture(trx, h.space, PUBLIC)
        })
        .catch((error: unknown) => {
          refused = error
        })
      expect(String(refused)).contains('atomic')
    })
  })

  describe('releasing an uploaded picture its write does not name', () => {
    const UPLOADED = `images/team/${'ab'.repeat(16)}`
    const held = (prefix: string): boolean[] =>
      [96, 192].map(size =>
        h.objects.has(object(imageKey(prefix, size as 96 | 192)))
      )
    const name = async (
      trx: Parameters<Parameters<typeof atomic>[1]>[0],
      prefix: string | null
    ): Promise<void> => {
      await trx
        .updateTable('teams')
        .set({ logo_path: prefix })
        .where('id', '=', 'tem_account')
        .execute()
    }

    it('keeps the picture once the write that names it commits', async () => {
      hold(UPLOADED)
      expect(
        await namingUploaded(h.db, h.space, UPLOADED, async trx => {
          await name(trx, UPLOADED)
          return 'named'
        })
      ).equals('named')
      await afterCommitsSettled()
      expect(await teamLogo()).equals(UPLOADED)
      expect(held(UPLOADED)).deep.equals([true, true])
    })

    it('releases it when the write throws once it has named it', async () => {
      hold(UPLOADED)
      let thrown: unknown
      await namingUploaded(h.db, h.space, UPLOADED, async trx => {
        await name(trx, UPLOADED)
        throw new Error('refused')
      }).catch((error: unknown) => {
        thrown = error
      })
      expect(String(thrown)).contains('refused')
      await afterCommitsSettled()
      expect(await teamLogo()).equals(null)
      expect(held(UPLOADED)).deep.equals([false, false])
    })

    it('releases it when the transaction the write is part of rolls back later', async () => {
      hold(UPLOADED)
      await atomic(h.db, async trx => {
        await namingUploaded(trx, h.space, UPLOADED, async inner => {
          await name(inner, UPLOADED)
        })
        // Named, but not committed: nothing goes yet.
        await afterCommitsSettled()
        expect(held(UPLOADED)).deep.equals([true, true])
        throw new Error('a later statement failed')
      }).catch(() => undefined)
      await afterCommitsSettled()
      expect(await teamLogo()).equals(null)
      expect(held(UPLOADED)).deep.equals([false, false])
    })

    it('refuses a transaction atomic did not open before the write, and releases the upload (1.harness-review.6)', async () => {
      hold(UPLOADED)
      let wrote = false
      let refused: unknown
      await h.db
        .transaction()
        .execute(async trx => {
          await namingUploaded(trx, h.space, UPLOADED, async inner => {
            wrote = true
            await name(inner, UPLOADED)
          })
        })
        .catch((error: unknown) => {
          refused = error
        })
      expect(String(refused)).contains('atomic')
      expect(wrote).equals(false)
      await afterCommitsSettled()
      expect(await teamLogo()).equals(null)
      expect(held(UPLOADED)).deep.equals([false, false])
    })

    it('never releases a catalog picture, an old prefix, or none', async () => {
      const catalog = pictureCatalog[0].prefix
      hold(catalog)
      hold(OLD)
      for (const prefix of [catalog, OLD, null])
        await namingUploaded(h.db, h.space, prefix, async () => {
          throw new Error('refused')
        }).catch(() => undefined)
      await afterCommitsSettled()
      expect(held(catalog)).deep.equals([true, true])
      expect(held(OLD)).deep.equals([true, true])
      expect(sent).deep.equals([])
    })

    it('releases it when the transaction never begins, and logs a release that fails', async () => {
      hold(UPLOADED)
      // Every query goes through; only the transaction cannot be opened.
      const closed = new Proxy(h.db, {
        get: (target, key) => {
          if (key === 'transaction')
            return () => ({
              execute: async () => {
                throw new Error('no connection for a transaction')
              }
            })
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      let thrown: unknown
      await namingUploaded(closed, h.space, UPLOADED, async () => {
        throw new Error('never runs')
      }).catch((error: unknown) => {
        thrown = error
      })
      expect(String(thrown)).contains('no connection')
      expect(held(UPLOADED)).deep.equals([false, false])

      hold(UPLOADED)
      const said: unknown[] = []
      const realError = console.error
      console.error = (...args: unknown[]) => {
        said.push(args.join(' '))
      }
      try {
        // No connection at all: neither the transaction nor the check runs.
        const unconnected: unknown = {}
        await namingUploaded(
          unconnected as typeof h.db,
          h.space,
          UPLOADED,
          async () => undefined
        ).catch(() => undefined)
      } finally {
        console.error = realError
      }
      expect(String(said[0])).contains(`releasing ${UPLOADED}`)
      expect(held(UPLOADED)).deep.equals([true, true])
    })

    it('refuses work after a rollback outside a transaction atomic opened', async () => {
      const refusals: unknown[] = []
      await afterRollback(h.db, async () => undefined).catch(
        (error: unknown) => {
          refusals.push(error)
        }
      )
      await h.db
        .transaction()
        .execute(async trx => {
          await afterRollback(trx, async () => undefined)
        })
        .catch((error: unknown) => {
          refusals.push(error)
        })
      expect(refusals.map(String)).length(2)
      for (const refused of refusals) expect(String(refused)).contains('atomic')
    })
  })
})
