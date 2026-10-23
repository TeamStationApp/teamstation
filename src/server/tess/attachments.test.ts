import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { TessAttachment, TessAttachmentBody } from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  attachmentBlock,
  classify,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  ownedAttachments,
  storeAttachment
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
        '5 MB'
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
