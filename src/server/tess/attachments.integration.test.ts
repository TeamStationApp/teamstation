import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  TESS_MAX_IMAGE_BYTES as MAX_IMAGE_BYTES,
  TESS_MAX_TEXT_BYTES as MAX_TEXT_BYTES,
  type TessAttachment,
  type TessAttachmentBody,
  tessUploadType as classify
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  attachmentBlock,
  isUuid,
  MAX_UNSENT_BYTES,
  ownedAttachments,
  pruneAttachments,
  storeAttachment,
  UNSENT_FULL
} from './attachments'

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('rest of a picture')
])
const JPEG = Buffer.concat([
  Buffer.from('ffd8ffe0', 'hex'),
  Buffer.from('jfif')
])
const GIF = Buffer.from('GIF89a and the rest')
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 ')
])

const base64 = (bytes: Buffer | string): string =>
  Buffer.from(bytes).toString('base64')

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('Expected a failure')
}

describe("Tess's attachments", function () {
  this.timeout(60000)
  let h: AccountHarness
  const babe = userIdOfGumbo(101)
  const lou = userIdOfGumbo(102)
  const store = async (
    body: TessAttachmentBody,
    userId = babe
  ): Promise<TessAttachment> => await storeAttachment(h.db, userId, body)

  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })

  it('takes each accepted type, and stores a picture as the image it is', async () => {
    for (const [name, mediaType, bytes, kind, stored] of [
      ['field.png', 'image/png', PNG, 'image', 'image/png'],
      ['field.jpg', 'image/jpg', JPEG, 'image', 'image/jpeg'],
      ['field.gif', 'image/gif', GIF, 'image', 'image/gif'],
      // Said to be a PNG, and a WebP all the same.
      ['field.webp', 'image/png', WEBP, 'image', 'image/webp'],
      ['runs.csv', 'text/csv', 'game,runs\n1,4\n', 'csv', 'text/csv'],
      [
        'notes.txt',
        'text/plain; charset=utf-8',
        'Bring water',
        'text',
        'text/plain'
      ],
      ['plan.md', 'text/markdown', '# Plan', 'markdown', 'text/markdown']
    ] as const) {
      const attachment = await store({
        name,
        mediaType,
        data: base64(bytes)
      })
      expect(attachment).deep.include({ name, kind })
      const row = await h.db
        .selectFrom('tess_attachments')
        .selectAll()
        .where('id', '=', attachment.id)
        .executeTakeFirstOrThrow()
      expect(row.media_type, name).equals(stored)
      expect(Buffer.compare(row.data!, Buffer.from(bytes))).equals(0)
    }
  })

  it('reads the type from the extension when the browser sent none, and takes a data URL', async () => {
    expect(
      (await store({ name: 'Runs.CSV', mediaType: '', data: base64('a,b') }))
        .kind
    ).equals('csv')
    expect(
      (
        await store({
          name: 'notes.md',
          mediaType: 'application/octet-stream',
          data: base64('# A')
        })
      ).kind
    ).equals('markdown')
    expect(
      (
        await store({
          name: 'list.txt',
          mediaType: '',
          data: `data:text/plain;base64,${base64('one\ntwo')}`
        })
      ).kind
    ).equals('text')
    expect(classify('notes', '')).equals(null)
    expect(classify('notes.pdf', 'application/pdf')).equals(null)
    // A CSV a browser on Windows calls a spreadsheet, as the app reads it.
    const spreadsheet = await store({
      name: 'runs.csv',
      mediaType: 'application/vnd.ms-excel',
      data: base64('game,runs')
    })
    expect(spreadsheet.kind).equals('csv')
    expect(isUuid(spreadsheet.id)).equals(true)
    expect(isUuid('not-a-uuid')).equals(false)
  })

  it('keeps a file name without its path or control characters', async () => {
    const attachment = await store({
      name: 'C:\\photos/../field\u0007.png',
      mediaType: 'image/png',
      data: base64(PNG)
    })
    expect(attachment.name).equals('field.png')
    expect(
      (await store({ name: '/', mediaType: 'image/png', data: base64(PNG) }))
        .name
    ).equals('attachment')
  })

  it('refuses the wrong type, an oversize file, non-UTF-8 text and bad base64', async () => {
    const cases: Array<[TessAttachmentBody, string, string]> = [
      [
        { name: 'a.pdf', mediaType: 'application/pdf', data: base64('%PDF') },
        'unsupportedMedia',
        'PNG'
      ],
      [
        {
          name: 'a.png',
          mediaType: 'image/png',
          data: base64('not a picture')
        },
        'unsupportedMedia',
        'not a PNG'
      ],
      [
        {
          name: 'big.png',
          mediaType: 'image/png',
          data: base64(Buffer.alloc(MAX_IMAGE_BYTES + 1))
        },
        'tooLarge',
        '3.75 MB'
      ],
      [
        {
          name: 'big.csv',
          mediaType: 'text/csv',
          data: base64(Buffer.alloc(MAX_TEXT_BYTES + 1, 'a'))
        },
        'tooLarge',
        '1 MB'
      ],
      [
        {
          name: 'latin.txt',
          mediaType: 'text/plain',
          data: base64(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
        },
        'badRequest',
        'UTF-8'
      ],
      [
        { name: 'a.txt', mediaType: 'text/plain', data: 'not*base64' },
        'badRequest',
        'base64'
      ],
      [
        { name: 'a.txt', mediaType: 'text/plain', data: '' },
        'badRequest',
        'empty'
      ]
    ]
    for (const [body, code, says] of cases) {
      const error = await failure(store(body))
      expect(error.code, body.name).equals(code)
      expect(error.message, body.name).includes(says)
    }
    // Far enough over that it is refused from its length, before decoding.
    const over = await failure(
      store({
        name: 'far.csv',
        mediaType: 'text/csv',
        data: base64(Buffer.alloc(MAX_TEXT_BYTES + 6, 'a'))
      })
    )
    expect(over.code).equals('tooLarge')
  })

  it('takes a picture whose base64 is at most the 5 MB the model takes, and refuses a larger one with 413', async () => {
    const picture = (size: number): Buffer =>
      Buffer.concat([PNG, Buffer.alloc(size - PNG.length)])
    expect(base64(picture(MAX_IMAGE_BYTES)).length).equals(5 * 1024 * 1024)
    const largest = await store({
      name: 'largest.png',
      mediaType: 'image/png',
      data: base64(picture(MAX_IMAGE_BYTES))
    })
    expect(largest.kind).equals('image')
    // Under the old 5 MB of bytes, and over what the model takes.
    const refused = await failure(
      store({
        name: 'four.png',
        mediaType: 'image/png',
        data: base64(picture(4 * 1024 * 1024))
      })
    )
    expect(refused.status).equals(413)
    expect(refused.message).equals('Pictures for Tess can be up to 3.75 MB')
  })

  it('lets a message name at most five of the caller’s own attachments', async () => {
    const mine = []
    for (let i = 0; i < 6; i += 1)
      mine.push(
        (
          await store({
            name: `n${i}.txt`,
            mediaType: 'text/plain',
            data: base64('x')
          })
        ).id
      )
    const theirs = (
      await store(
        { name: 'theirs.txt', mediaType: 'text/plain', data: base64('y') },
        lou
      )
    ).id
    const rows = await ownedAttachments(h.db, babe, [mine[1], mine[0], mine[1]])
    expect(rows.map(row => row.id)).deep.equals([mine[1], mine[0]])
    expect(await ownedAttachments(h.db, babe, [])).deep.equals([])
    for (const [ids, says] of [
      [mine, 'at most 5'],
      [[mine[0], theirs], 'Unknown attachment'],
      [[randomUUID()], 'Unknown attachment'],
      [['not-a-uuid'], 'Unknown attachment']
    ] as const) {
      const error = await failure(ownedAttachments(h.db, babe, ids))
      expect(error.code).equals('badRequest')
      expect(error.message).includes(says)
    }
  })

  describe('held for a message', function () {
    const row = async (
      bytes: number,
      age: 'new' | 'old' = 'new',
      userId = lou
    ): Promise<string> => {
      const id = randomUUID()
      await h.db
        .insertInto('tess_attachments')
        .values({
          id,
          user_id: userId,
          name: 'held.csv',
          media_type: 'text/csv',
          kind: 'csv',
          data: Buffer.alloc(bytes, 'a'),
          ...(age === 'old'
            ? { created_at: sql<Date>`now() - interval '25 hours'` }
            : {})
        })
        .execute()
      return id
    }
    const named = async (id: string): Promise<void> => {
      await h.db
        .insertInto('tess_messages')
        .values({
          user_id: lou,
          role: 'user',
          content: JSON.stringify([
            { type: 'text', text: 'Look' },
            { type: 'attachment', id }
          ])
        })
        .execute()
    }
    const ids = async (userId = lou): Promise<string[]> =>
      (
        await h.db
          .selectFrom('tess_attachments')
          .select('id')
          .where('user_id', '=', userId)
          .execute()
      )
        .map(each => each.id)
        .sort()
    const csv = (bytes: number): TessAttachmentBody => ({
      name: 'small.csv',
      mediaType: 'text/csv',
      data: base64(Buffer.alloc(bytes, 'a'))
    })

    beforeEach(async () => {
      await h.db.deleteFrom('tess_messages').execute()
      await h.db
        .deleteFrom('tess_attachments')
        .where('user_id', '=', lou)
        .execute()
    })

    it('holds at most 25 MB a person of uploads no message names, refused with 413', async () => {
      const big = await row(MAX_UNSENT_BYTES - 3000)
      await store(csv(1000), lou)
      const refused = await failure(store(csv(2001), lou))
      expect(refused.status).equals(413)
      expect(refused.message).equals(UNSENT_FULL)
      // Up to the cap is taken, and another person's uploads are their own.
      await store(csv(2000), lou)
      await store(csv(2000), babe)
      // Once a message names it, an upload is no longer held for one.
      await named(big)
      await store(csv(2000), lou)
    })

    it('clears uploads no message names after a day, at the next upload, and keeps the rest', async () => {
      const stale = await row(10, 'old')
      const sent = await row(10, 'old')
      await named(sent)
      const fresh = await row(10)
      const theirs = await row(10, 'old', babe)
      const added = (await store(csv(10), lou)).id
      expect(await ids()).deep.equals([sent, fresh, added].sort())
      expect(await ids(babe)).includes(theirs)

      // A message being sent keeps the old uploads it names.
      const kept = await row(10, 'old')
      const dropped = await row(10, 'old')
      await pruneAttachments(h.db, lou, [kept])
      expect(await ids()).includes(kept)
      expect(await ids()).not.includes(dropped)
      expect(await ids()).not.includes(stale)
    })
  })

  it('sends a picture as an image, text headed by its name, and a described one as its description', function () {
    expect(
      attachmentBlock({
        name: 'field.png',
        media_type: 'image/png',
        kind: 'image',
        data: PNG,
        description: null
      })
    ).deep.equals({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64(PNG) }
    })
    expect(
      attachmentBlock({
        name: 'runs.csv',
        media_type: 'text/csv',
        kind: 'csv',
        data: Buffer.from('game,runs'),
        description: null
      })
    ).deep.equals({
      type: 'text',
      text: 'Attachment runs.csv (csv):\ngame,runs'
    })
    expect(
      attachmentBlock({
        name: 'runs.csv',
        media_type: 'text/csv',
        kind: 'csv',
        data: null,
        description: 'Runs per game: 4, 2'
      })
    ).deep.equals({
      type: 'text',
      text: 'Attachment runs.csv (described): Runs per game: 4, 2'
    })
  })
})
