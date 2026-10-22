import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  ChatCoreStatus,
  CoreUnavailableReason
} from '../../common/chatCrypto/coreCall'
import { HttpError } from '../../common/errors'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatCoreGate } from './ChatCoreGate'
import { chatCoreLog, chatStartFailure, chatStartLog } from './chatCoreLog'
import { ChatUnavailable } from './ChatUnavailable'
import { storedRecordFromJson, UnreadableKeyRecordError } from './keyRecord'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

/** Chat behind its crypto core: nothing under the gate mounts without it. */
describe('ChatCoreGate', () => {
  function gate(
    loadCore: () => Promise<ChatCoreStatus>,
    told: CoreUnavailableReason[]
  ): React.ReactElement {
    const Chat = (): React.ReactElement => {
      // What would enrol, link or open the key store, were it drawn.
      told.push('loading')
      return <>the chat</>
    }
    return (
      <ChatCoreGate
        loadCore={loadCore}
        coreStatus={() => ({ ready: false, reason: 'loading' })}
        onUnavailable={reason => {
          told.push(reason)
        }}
      >
        <Chat />
      </ChatCoreGate>
    )
  }

  it('opens chat once the core is ready, and not before', async () => {
    let settle: (status: ChatCoreStatus) => void = () => undefined
    const told: CoreUnavailableReason[] = []
    await render(
      gate(
        async () =>
          await new Promise(resolve => {
            settle = resolve
          }),
        told
      )
    )
    expect(text()).contains('Opening chat')
    expect(told).deep.equals([])
    await act(async () => {
      settle({ ready: true })
      await delay(10)
    })
    expect(text()).contains('the chat')
    expect(told).deep.equals(['loading'])
  })

  it('without WebAssembly: says so and why, mounts nothing, and tells the log', async () => {
    const told: CoreUnavailableReason[] = []
    await render(
      gate(async () => ({ ready: false, reason: 'noWebAssembly' }), told)
    )
    expect(text()).contains('Chat needs WebAssembly')
    expect(text()).contains('Lockdown Mode')
    expect(text()).contains('Everything else in TeamStation works')
    expect(text()).not.contains('the chat')
    expect(told).deep.equals(['noWebAssembly'])
  })

  it('a module that did not load or check out needs WebAssembly too', async () => {
    for (const reason of [
      'fetchFailed',
      'instantiateFailed',
      'selfTestFailed'
    ] as const) {
      const told: CoreUnavailableReason[] = []
      await render(gate(async () => ({ ready: false, reason }), told))
      expect(text(), reason).contains('Chat needs WebAssembly')
      expect(text(), reason).contains('could not load chat’s encryption')
      expect(told).deep.equals([reason])
      act(() => {
        root?.unmount()
      })
      document.body.innerHTML = ''
    }
  })

  it('a phone build without the native module has no chat at all', async () => {
    const told: CoreUnavailableReason[] = []
    await render(
      gate(async () => ({ ready: false, reason: 'noNativeModule' }), told)
    )
    expect(text()).contains('Chat is not available in this build')
    expect(text()).not.contains('WebAssembly')
    expect(told).deep.equals(['noNativeModule'])
  })

  it('on a phone, any missing core is "not available in this build"', async () => {
    for (const platform of ['ios', 'android']) {
      for (const reason of ['selfTestFailed', 'instantiateFailed'] as const) {
        await render(<ChatUnavailable reason={reason} platform={platform} />)
        expect(text(), `${platform} ${reason}`).contains(
          'Chat is not available in this build'
        )
        expect(text(), `${platform} ${reason}`).not.contains('WebAssembly')
        expect(text(), `${platform} ${reason}`).not.contains('Reload')
        act(() => {
          root?.unmount()
        })
        document.body.innerHTML = ''
      }
    }
  })

  it('draws at once from a core that settled earlier', async () => {
    let asked = 0
    const pending = async (): Promise<ChatCoreStatus> => {
      asked += 1
      return await new Promise(() => {})
    }
    await render(
      <ChatCoreGate loadCore={pending} coreStatus={() => ({ ready: true })}>
        <>the chat</>
      </ChatCoreGate>
    )
    expect(text()).equals('the chat')
    act(() => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    await render(
      <ChatCoreGate
        loadCore={pending}
        coreStatus={() => ({ ready: false, reason: 'noWebAssembly' })}
      >
        <>the chat</>
      </ChatCoreGate>
    )
    expect(text()).contains('Chat needs WebAssembly')
    expect(asked).equals(2)
  })

  it('waits on a module asked for again, not on the last failure', async () => {
    let arrive: (status: ChatCoreStatus) => void = () => {}
    const again = async (): Promise<ChatCoreStatus> =>
      await new Promise(resolve => {
        arrive = resolve
      })
    await render(
      <ChatCoreGate
        loadCore={again}
        coreStatus={() => ({ ready: false, reason: 'fetchFailed' })}
      >
        <>the chat</>
      </ChatCoreGate>
    )
    expect(text()).contains('Opening chat')
    await act(async () => {
      arrive({ ready: true })
      await delay(10)
    })
    expect(text()).equals('the chat')
  })

  it('after the module traps, shows why and tells the log', async () => {
    const told: CoreUnavailableReason[] = []
    await render(
      <ChatCoreGate
        loadCore={async () => ({ ready: false, reason: 'trapped' })}
        coreStatus={() => ({ ready: false, reason: 'trapped' })}
        onUnavailable={reason => {
          told.push(reason)
        }}
      >
        <>the chat</>
      </ChatCoreGate>
    )
    expect(text()).contains('Chat needs WebAssembly')
    expect(text()).not.contains('the chat')
    expect(told).deep.equals(['trapped'])
  })

  it('a loader that throws is a module that would not instantiate', async () => {
    const told: CoreUnavailableReason[] = []
    await render(
      gate(async () => {
        throw new Error('boom')
      }, told)
    )
    expect(text()).contains('Chat needs WebAssembly')
    expect(told).deep.equals(['instantiateFailed'])
  })
})

describe('chatCoreLog', () => {
  it('posts the reason to /logs as chatCore-<platform>, and survives a failed post', async () => {
    const posts: Array<{ url: string; body: any }> = []
    const warned: string[] = []
    const realWarn = console.warn
    console.warn = (line: string) => {
      warned.push(line)
    }
    try {
      const log = chatCoreLog(
        'http://api.example/api/v1',
        'web',
        async (url, body) => {
          posts.push({ url, body: JSON.parse(body) })
          throw new Error('offline')
        }
      )
      log('fetchFailed')
      // The same reason again, as each chat screen reports it: told once.
      log('fetchFailed')
      await delay(10)
    } finally {
      console.warn = realWarn
    }
    expect(warned).deep.equals(['Chat crypto core unavailable: fetchFailed'])
    expect(posts).lengthOf(1)
    expect(posts[0].url).equals('http://api.example/api/v1/logs')
    expect(posts[0].body.source).equals('chatCore-web')
    expect(posts[0].body.lines[0]).deep.include({
      level: 'warn',
      text: 'Chat crypto core unavailable: fetchFailed',
      data: { reason: 'fetchFailed' }
    })
  })

  it('posts with fetch, as JSON, when given nothing else', async () => {
    const realFetch = globalThis.fetch
    const realWarn = console.warn
    const asked: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      asked.push({ url, init })
      return new Response('{}')
    }) as typeof fetch
    console.warn = () => undefined
    try {
      chatCoreLog('/api/v1', 'ios')('noNativeModule')
      await delay(10)
    } finally {
      globalThis.fetch = realFetch
      console.warn = realWarn
    }
    expect(asked).lengthOf(1)
    expect(asked[0].url).equals('/api/v1/logs')
    expect(asked[0].init.method).equals('POST')
    expect(asked[0].init.headers).deep.equals({
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(asked[0].init.body as string).source).equals(
      'chatCore-ios'
    )
  })
})

describe('chatStartLog', () => {
  it('names why chat did not start without any of the saved keys', () => {
    const unreadable = (() => {
      try {
        storedRecordFromJson('{"secret":"do-not-log"')
      } catch (error) {
        return error
      }
    })()
    expect(unreadable).instanceOf(UnreadableKeyRecordError)
    expect(chatStartFailure(unreadable)).equals('storedRecord:invalid')
    expect(
      chatStartFailure(new UnreadableKeyRecordError('wrappingKeyMissing'))
    ).equals('storedRecord:wrappingKeyMissing')
    expect(chatStartFailure(new HttpError('offline', 'gone'))).equals(
      'http:offline'
    )
    expect(chatStartFailure(new TypeError('Failed to fetch'))).equals(
      'TypeError'
    )
    expect(chatStartFailure('odd')).equals('string')
  })

  it('posts the reason to /logs as chatStart-<platform>, once per reason', async () => {
    const posts: Array<{ url: string; body: any }> = []
    const warned: string[] = []
    const realWarn = console.warn
    console.warn = (line: string) => {
      warned.push(line)
    }
    try {
      const log = chatStartLog(
        'http://api.example/api/v1',
        'web',
        async (url, body) => {
          posts.push({ url, body: JSON.parse(body) })
          throw new Error('offline')
        }
      )
      log(new UnreadableKeyRecordError('unknownVersion'))
      // Try again, failing the same way: told once.
      log(new UnreadableKeyRecordError('unknownVersion'))
      log(new HttpError('offline', 'gone'))
      await delay(10)
    } finally {
      console.warn = realWarn
    }
    expect(warned).deep.equals([
      'Chat could not start: storedRecord:unknownVersion',
      'Chat could not start: http:offline'
    ])
    expect(posts).lengthOf(2)
    expect(posts[0].url).equals('http://api.example/api/v1/logs')
    expect(posts[0].body.source).equals('chatStart-web')
    expect(posts[0].body.lines[0]).deep.include({
      level: 'warn',
      text: 'Chat could not start: storedRecord:unknownVersion',
      data: { reason: 'storedRecord:unknownVersion' }
    })
  })
})
