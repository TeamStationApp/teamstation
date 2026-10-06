import Module from 'node:module'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type * as NativeFiles from './chatFiles.native'

/**
 * U13: the phones' attachment twin, on stand-ins for the native modules it
 * uses (`react-native-image-picker`, `@react-native-documents/picker`,
 * `react-native-blob-util`, `react-native-quick-base64` and React Native's
 * `Platform`), put where Node would load each package from. The bytes come
 * back through the blob-util stand-in's files, as base64.
 */

const files = new Map<string, string>()
const log: string[] = []
let library: Record<string, unknown> = {}
let documents: unknown = []
let os = 'ios'

const standIns: Record<string, unknown> = {
  'react-native': {
    Platform: {
      get OS() {
        return os
      }
    }
  },
  'react-native-image-picker': {
    launchImageLibrary: async (options: Record<string, unknown>) => {
      log.push(`library ${JSON.stringify(options)}`)
      return library
    }
  },
  '@react-native-documents/picker': {
    pick: async (options: Record<string, unknown>) => {
      log.push(`pick ${JSON.stringify(options)}`)
      if (documents instanceof Error) throw documents
      return documents
    },
    keepLocalCopy: async (options: {
      files: Array<{ uri: string; fileName: string }>
    }) => {
      const [file] = options.files
      log.push(`copy ${file.uri} ${file.fileName}`)
      if (file.uri.includes('unreadable')) {
        return [{ status: 'error', sourceUri: file.uri, copyError: 'denied' }]
      }
      const local = `file:///cache/${file.fileName}`
      files.set(`/cache/${file.fileName}`, files.get(file.uri) ?? '')
      return [{ status: 'success', sourceUri: file.uri, localUri: local }]
    }
  },
  'react-native-blob-util': {
    __esModule: true,
    default: {
      fs: {
        dirs: { CacheDir: '/cache' },
        readFile: async (path: string, encoding: string) => {
          log.push(`read ${path} ${encoding}`)
          const found = files.get(path)
          if (found == null) throw new Error(`no ${path}`)
          return found
        },
        writeFile: async (path: string, data: string, encoding: string) => {
          log.push(
            `write ${path.replace(/chat-\d+-\d+-/, 'chat-N-')} ${encoding}`
          )
          files.set(path, data)
        },
        unlink: async (path: string) => {
          log.push(`unlink ${path.replace(/chat-\d+-\d+-/, 'chat-N-')}`)
          if (!files.delete(path)) throw new Error('missing')
        }
      },
      ios: {
        presentOptionsMenu: (path: string) => {
          log.push(`share ${path.replace(/chat-\d+-\d+-/, 'chat-N-')}`)
        }
      },
      android: {
        actionViewIntent: async (path: string, type: string) => {
          log.push(`view ${path.replace(/chat-\d+-\d+-/, 'chat-N-')} ${type}`)
          return true
        }
      }
    }
  },
  'react-native-quick-base64': {
    toByteArray: (text: string) => new Uint8Array(Buffer.from(text, 'base64')),
    fromByteArray: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  }
}

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

describe('attachments on a phone', function () {
  let twin: typeof NativeFiles
  const held = new Map<string, NodeJS.Module | undefined>()

  before(async function () {
    for (const [name, exports] of Object.entries(standIns)) {
      const path = require.resolve(name)
      held.set(path, require.cache[path])
      const stand = new Module(path)
      stand.filename = path
      stand.loaded = true
      stand.exports = exports
      require.cache[path] = stand
    }
    twin = await import('./chatFiles.native')
  })

  after(function () {
    for (const [path, module] of held) {
      if (module == null) Reflect.deleteProperty(require.cache, path)
      else require.cache[path] = module
    }
  })

  it('offers the photo library and files', function () {
    expect(twin.PICK_SOURCES).deep.equals(['photos', 'files'])
  })

  it('reads photos and videos from the library as bytes', async function () {
    log.length = 0
    files.set('/tmp/IMG 1.jpg', b64([1, 2, 3]))
    files.set('/tmp/clip.mov', b64([4]))
    library = {
      assets: [
        {
          uri: 'file:///tmp/IMG%201.jpg',
          type: 'image/jpeg',
          fileName: 'IMG 1.jpg',
          width: 4032,
          height: 3024
        },
        { uri: 'file:///tmp/clip.mov', duration: 12.5 },
        { fileName: 'no uri' }
      ]
    }
    const picked = await twin.pickFiles('photos')
    expect(picked).deep.equals([
      {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
        fileName: 'IMG 1.jpg',
        width: 4032,
        height: 3024
      },
      {
        bytes: new Uint8Array([4]),
        contentType: 'application/octet-stream',
        fileName: 'photo',
        durationMs: 12500
      }
    ])
    expect(log[0]).equals('library {"mediaType":"mixed","selectionLimit":1}')
    expect(log).includes('read /tmp/IMG 1.jpg base64')

    library = { didCancel: true }
    expect(await twin.pickFiles('photos')).deep.equals([])
    library = { assets: [], errorCode: 'permission' }
    let refused: unknown
    await twin.pickFiles('photos').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('permission')
    library = { assets: [], errorCode: 'others', errorMessage: 'broken' }
    refused = undefined
    await twin.pickFiles('photos').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('broken')
  })

  it('reads any file through a local copy, and lets the copy go', async function () {
    log.length = 0
    files.set('content://doc/1', b64([7, 8]))
    documents = [
      {
        uri: 'content://doc/1',
        name: 'Roster (1).pdf',
        type: 'application/pdf'
      }
    ]
    const picked = await twin.pickFiles('files')
    expect(picked).deep.equals([
      {
        bytes: new Uint8Array([7, 8]),
        contentType: 'application/pdf',
        fileName: 'Roster (1).pdf'
      }
    ])
    expect(log).deep.equals([
      'pick {"allowMultiSelection":true}',
      'copy content://doc/1 Roster_1_.pdf',
      'read /cache/Roster_1_.pdf base64',
      'unlink /cache/Roster_1_.pdf'
    ])
    documents = [{ uri: 'content://doc/unreadable', name: null, type: null }]
    let refused: unknown
    await twin.pickFiles('files').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('denied')
    documents = Object.assign(new Error('cancelled'), {
      code: 'OPERATION_CANCELED'
    })
    expect(await twin.pickFiles('files')).deep.equals([])
    documents = new Error('broken picker')
    refused = undefined
    await twin.pickFiles('files').catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).contains('broken picker')
  })

  it('writes opened bytes to the cache, and deletes them when let go', async function () {
    log.length = 0
    const uri = await twin.bytesUri(
      new Uint8Array([5, 6]),
      'video/mp4',
      'clip.mp4'
    )
    expect(uri).matches(/^file:\/\/\/cache\/chat-\d+-\d+-clip\.mp4$/)
    expect(files.get(uri.replace('file://', ''))).equals(b64([5, 6]))
    await twin.releaseUri(uri)
    expect(files.has(uri.replace('file://', ''))).equals(false)
    await twin.releaseUri(uri)
    await twin.releaseUri('blob:not-a-file')
    expect(log).deep.equals([
      'write /cache/chat-N-clip.mp4 base64',
      'unlink /cache/chat-N-clip.mp4',
      'unlink /cache/chat-N-clip.mp4'
    ])
  })

  it('shares a saved file on iOS, and opens it on Android', async function () {
    log.length = 0
    os = 'ios'
    await twin.saveFile(new Uint8Array([1]), 'application/pdf', 'roster.pdf')
    os = 'android'
    await twin.saveFile(new Uint8Array([1]), 'application/pdf', 'roster.pdf')
    expect(log).deep.equals([
      'write /cache/chat-N-roster.pdf base64',
      'share /cache/chat-N-roster.pdf',
      'write /cache/chat-N-roster.pdf base64',
      'view /cache/chat-N-roster.pdf application/pdf'
    ])
  })
})
