import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { ChatBench, chatBenchPath } from './chatBench'
import { benchFor } from './chatBench.native'
import type { ChatBenchResult } from './chatBenchRun'
import { ChatBenchScreen } from './ChatBenchScreen'

/** U3: the bench screen shows its figures and then `done`. */
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

describe('ChatBenchScreen', () => {
  it('is in a served web build, which defines __DEV__ as this bundle does', () => {
    // A production build defines it false and has no bench: the real build
    // in buildCsp.test.ts checks its bundle for the route.
    expect(chatBenchPath).equals('/dev/chat-bench')
    expect(ChatBench).equals(ChatBenchScreen)
  })

  it('is in a phone build only when TS_CHAT_BENCH is 1', () => {
    expect(benchFor('1')).deep.equals({
      path: '/dev/chat-bench',
      screen: ChatBenchScreen
    })
    for (const flag of [undefined, '', '0', 'true']) {
      expect(benchFor(flag)).deep.equals({ path: undefined, screen: undefined })
    }
  })

  it('says it is running, then shows stream MB/s, wraps/s and done', async () => {
    await render(<ChatBenchScreen bytes={65536} wraps={2} />)
    expect(text()).contains('Running')
    expect(text()).not.contains('done')
    await act(async () => {
      await delay(400)
    })
    expect(text()).contains('vectors ok')
    expect(text()).contains('stream MB/s: ')
    expect(text()).contains('wraps/s: ')
    expect(text()).contains('(2 in ')
    expect(text()).contains('done')
    expect(text()).not.contains('Running')
  })

  it('passes its sizes to the bench it is given', async () => {
    const asked: unknown[] = []
    const run = (options: object): ChatBenchResult => {
      asked.push(options)
      return {
        bytes: 1,
        wraps: 1,
        sealMs: 1,
        openMs: 1,
        wrapMs: 1,
        sealMBps: 12,
        openMBps: 13,
        streamMBps: 12,
        wrapsPerSecond: 99
      }
    }
    await render(
      <ChatBenchScreen
        bytes={10}
        wraps={1}
        run={run}
        checkVectors={() => 'vectors failed: seal (got 00)'}
      />
    )
    await act(async () => {
      await delay(400)
    })
    expect(asked).deep.equals([{ bytes: 10, wraps: 1, now: undefined }])
    expect(text()).contains('stream MB/s: 12.0')
    expect(text()).contains('vectors failed: seal (got 00)')
  })

  it('shows a failure, and still says done', async () => {
    await render(
      <ChatBenchScreen
        checkVectors={() => 'vectors ok'}
        run={() => {
          throw new Error('stream did not round-trip')
        }}
      />
    )
    await act(async () => {
      await delay(400)
    })
    expect(text()).contains('failed: stream did not round-trip')
    expect(text()).contains('done')
  })

  it('waits for the core, and runs nothing without it', async () => {
    let ran = false
    let settle: (status: {
      ready: false
      reason: 'noWebAssembly'
    }) => void = () => undefined
    await render(
      <ChatBenchScreen
        loadCore={async () =>
          await new Promise(resolve => {
            settle = resolve
          })
        }
        checkVectors={() => {
          ran = true
          return 'vectors ok'
        }}
      />
    )
    await act(async () => {
      await delay(400)
    })
    expect(text()).contains('Running')
    await act(async () => {
      settle({ ready: false, reason: 'noWebAssembly' })
      await delay(400)
    })
    expect(ran).equals(false)
    expect(text()).contains('failed: no chat crypto core: noWebAssembly')
    expect(text()).contains('done')
  })

  it('shows a loader that throws', async () => {
    await render(
      <ChatBenchScreen
        loadCore={async () => {
          throw new Error('no module')
        }}
      />
    )
    await act(async () => {
      await delay(50)
    })
    expect(text()).contains('failed: no module')
  })

  it('shows something thrown that is not an Error', async () => {
    await render(
      <ChatBenchScreen
        checkVectors={() => 'vectors ok'}
        run={() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'odd'
        }}
      />
    )
    await act(async () => {
      await delay(400)
    })
    expect(text()).contains('failed: odd')
  })
})
