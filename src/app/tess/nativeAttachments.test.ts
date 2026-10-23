import type {
  DocumentPickerOptions,
  DocumentPickerResponse
} from '@react-native-documents/picker'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import {
  chooseNativeAttachment,
  DOCUMENT_TYPES,
  type NativePickers
} from './nativeAttachments'
import {
  decodedSize,
  IMAGE_LIMIT,
  TEXT_LIMIT,
  uploadTypeOf
} from './tessUploads'

const CSV = Buffer.from('Team,Runs\nComets,12\n').toString('base64')

function document(
  overrides: Partial<DocumentPickerResponse> = {}
): DocumentPickerResponse {
  return {
    uri: 'file:///tmp/runs.csv',
    name: 'runs.csv',
    error: null,
    type: 'text/csv',
    nativeType: 'public.comma-separated-values-text',
    size: 20,
    isVirtual: false,
    convertibleToMimeTypes: null,
    hasRequestedType: true,
    ...overrides
  }
}

function pickers(overrides: Partial<NativePickers> = {}): NativePickers & {
  photoOptions: ImageLibraryOptions[]
  documentOptions: DocumentPickerOptions[]
  read: string[]
} {
  const photoOptions: ImageLibraryOptions[] = []
  const documentOptions: DocumentPickerOptions[] = []
  const read: string[] = []
  return {
    os: 'ios',
    launchImageLibrary: async options => {
      photoOptions.push(options)
      return { didCancel: true }
    },
    pickDocument: async options => {
      documentOptions.push(options)
      return [document()]
    },
    readFile: async uri => {
      read.push(uri)
      return CSV
    },
    ...overrides,
    photoOptions,
    documentOptions,
    read
  }
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('Expected a refusal')
}

function photo(response: ImagePickerResponse): Partial<NativePickers> {
  return { launchImageLibrary: async () => response }
}

describe('chooseNativeAttachment', function () {
  it('maps a photo from the library, one picture with its bytes', async function () {
    const fakes = pickers({
      launchImageLibrary: async options => {
        fakes.photoOptions.push(options)
        return {
          assets: [{ base64: 'iVBORw==', type: 'image/jpg', fileName: 'a.jpg' }]
        }
      }
    })
    expect(await chooseNativeAttachment('photo', fakes)).deep.equals({
      name: 'a.jpg',
      mediaType: 'image/jpeg',
      data: 'iVBORw=='
    })
    expect(fakes.photoOptions[0]).deep.include({
      mediaType: 'photo',
      selectionLimit: 1,
      includeBase64: true
    })
    expect(
      await chooseNativeAttachment(
        'photo',
        pickers(photo({ assets: [{ base64: 'R0lG', type: 'image/gif' }] }))
      )
    ).deep.equals({ name: 'photo', mediaType: 'image/gif', data: 'R0lG' })
  })

  it('maps a file from the document picker, read as base64', async function () {
    const fakes = pickers()
    expect(await chooseNativeAttachment('file', fakes)).deep.equals({
      name: 'runs.csv',
      mediaType: 'text/csv',
      data: CSV
    })
    expect(fakes.documentOptions).deep.equals([
      { type: DOCUMENT_TYPES.ios, allowMultiSelection: false, mode: 'import' }
    ])
    expect(fakes.read).deep.equals(['file:///tmp/runs.csv'])
    const android = pickers({ os: 'android' })
    await chooseNativeAttachment('file', android)
    expect(android.documentOptions[0].type).deep.equals(DOCUMENT_TYPES.android)
    expect(
      await chooseNativeAttachment(
        'file',
        pickers({
          pickDocument: async () => [
            document({ name: 'notes.md', type: null, size: null })
          ]
        })
      )
    ).deep.equals({ name: 'notes.md', mediaType: 'text/markdown', data: CSV })
    expect(
      await chooseNativeAttachment(
        'file',
        pickers({
          pickDocument: async () => [
            document({ name: null, type: 'text/plain' })
          ]
        })
      )
    ).deep.equals({ name: 'file.txt', mediaType: 'text/plain', data: CSV })
  })

  it('answers null when either picker is cancelled', async function () {
    expect(await chooseNativeAttachment('photo', pickers())).equals(null)
    expect(
      await chooseNativeAttachment(
        'file',
        pickers({
          pickDocument: async () => {
            throw Object.assign(new Error('cancelled'), {
              code: 'OPERATION_CANCELED'
            })
          }
        })
      )
    ).equals(null)
    expect(
      await chooseNativeAttachment(
        'file',
        pickers({ pickDocument: async () => [] })
      )
    ).equals(null)
  })

  it('refuses types Tess cannot read', async function () {
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'photo',
            pickers(photo({ assets: [{ base64: 'AAAA', type: 'image/heic' }] }))
          )
      )
    ).equals('Tess reads images, CSV, plain text and Markdown files.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              pickDocument: async () => [
                document({ name: 'scores.pdf', type: 'application/pdf' })
              ]
            })
          )
      )
    ).equals('Tess reads images, CSV, plain text and Markdown files.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              pickDocument: async () => [
                document({ name: 'chart.png', type: 'image/png' })
              ]
            })
          )
      )
    ).equals('Tess reads images, CSV, plain text and Markdown files.')
  })

  it('refuses files over the limits', async function () {
    const big = 'A'.repeat(Math.ceil(((IMAGE_LIMIT + 3) * 4) / 3))
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'photo',
            pickers(
              photo({
                assets: [
                  { base64: big, type: 'image/png', fileName: 'big.png' }
                ]
              })
            )
          )
      )
    ).equals('big.png is too large to attach.')
    const fakes = pickers({
      pickDocument: async () => [document({ size: TEXT_LIMIT + 1 })]
    })
    expect(
      await failure(async () => await chooseNativeAttachment('file', fakes))
    ).equals('runs.csv is too large to attach.')
    expect(fakes.read).deep.equals([])
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              pickDocument: async () => [document({ size: null })],
              readFile: async () =>
                'A'.repeat(Math.ceil(((TEXT_LIMIT + 3) * 4) / 3))
            })
          )
      )
    ).equals('runs.csv is too large to attach.')
  })

  it('says why when a picker or a read fails', async function () {
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'photo',
            pickers(photo({ errorCode: 'permission' }))
          )
      )
    ).equals('The file could not be opened. Please try again.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment('photo', pickers(photo({ assets: [] })))
      )
    ).equals('That file could not be read.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              pickDocument: async () => {
                throw new Error('NULL_PRESENTER')
              }
            })
          )
      )
    ).equals('The file could not be opened. Please try again.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              pickDocument: async () => [document({ error: 'virtual file' })]
            })
          )
      )
    ).equals('That file could not be read.')
    expect(
      await failure(
        async () =>
          await chooseNativeAttachment(
            'file',
            pickers({
              readFile: async () => {
                throw new Error('EACCES')
              }
            })
          )
      )
    ).equals('That file could not be read.')
  })
})

describe('upload types', function () {
  it('reads the type, its aliases, or the name', function () {
    expect(uploadTypeOf('a.png', 'image/png')).deep.equals({
      mediaType: 'image/png',
      kind: 'image'
    })
    expect(uploadTypeOf('a', 'TEXT/CSV; charset=utf-8')).deep.equals({
      mediaType: 'text/csv',
      kind: 'csv'
    })
    expect(uploadTypeOf('a', 'text/x-markdown')?.kind).equals('markdown')
    expect(uploadTypeOf('a.webp', '')?.mediaType).equals('image/webp')
    expect(uploadTypeOf('notes.TXT', undefined)?.kind).equals('text')
    expect(uploadTypeOf('a.markdown', 'application/octet-stream')?.kind).equals(
      'markdown'
    )
    expect(uploadTypeOf('scores.pdf', 'application/pdf')).equals(null)
    expect(uploadTypeOf('README', null)).equals(null)
  })

  it('counts the bytes in base64', function () {
    expect(decodedSize('')).equals(0)
    expect(decodedSize('YQ==')).equals(1)
    expect(decodedSize('YWI=')).equals(2)
    expect(decodedSize('YWJj')).equals(3)
  })
})
