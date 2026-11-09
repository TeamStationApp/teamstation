import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { pictureCatalog } from '../../common/pictureCatalog'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { imageKey, isPublicImagePrefix } from './images'
import { imageUrl } from './imageUrls'
import { republishOwnedImages } from './republishImages'
import type { SpaceSettings } from './spacesHls'

const OLD = 'images/team/tem_account/abcd1234'

describe('republishing owned pictures', function () {
  this.timeout(60000)
  let h: AccountHarness
  /** Every request the Space was sent, as `<method> <path>`. */
  let sent: string[] = []
  /** The `x-amz-acl` each PUT carried, by path. */
  let acls = new Map<string, string | null>()
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
        if (method === 'PUT')
          acls.set(
            url.pathname,
            new Headers(init?.headers).get('x-amz-acl') ?? null
          )
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

  it('copies an owned old picture to a public key, points the row at it, and deletes the old', async () => {
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
      expect(sent).includes(`DELETE ${object(imageKey(OLD, size))}`)
      expect(h.objects.has(object(imageKey(OLD, size)))).equals(false)
    }
    expect(new URL(imageUrl(h.space, next) ?? '').search).equals('')
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

  it('leaves the row on its old prefix when the copy fails, and says so', async () => {
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
    expect(said.join('\n')).contains(OLD)
  })

  it('keeps the move when an old object cannot be deleted, and says so', async () => {
    hold(OLD)
    await h.db
      .updateTable('teams')
      .set({ logo_path: OLD })
      .where('id', '=', 'tem_account')
      .execute()
    const recording = globalThis.fetch
    globalThis.fetch = async (input, init) =>
      init?.method === 'DELETE'
        ? new Response('<Error><Code>InternalError</Code></Error>', {
            status: 500
          })
        : await recording(input, init)
    const said: string[] = []
    try {
      expect(
        await republishOwnedImages(h.db, h.space, message => {
          said.push(message)
        })
      ).deep.equals({ moved: 1, skipped: 0, failed: 0 })
    } finally {
      globalThis.fetch = recording
    }
    expect(isPublicImagePrefix((await teamLogo()) ?? '')).equals(true)
    expect(said).length(2)
    expect(said[0]).contains(imageKey(OLD, 96))
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
})
