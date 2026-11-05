import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import type { ChatAge, ChatAgeSource } from '../../common/chatAge'
import { HttpError } from '../../common/errors'
import { chatAgeSheet, pressChatAge } from '../../test/chatAgeTesting'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  type ChatAccess,
  ChatAgeContext,
  ChatAgeHost,
  ChatAgeSheet,
  type ChatAgeState,
  ChatFrameKey,
  useChatAge,
  useChatAgeAsk,
  useChatAgeState
} from './ChatAgeGate'
import type { AppleAge } from './declaredAge'

let root: Root | undefined
const delay = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function draw(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay()
  })
}
async function settle(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action()
    await delay()
  })
}

const unconfirmed: ChatAge = {
  confirmed: false,
  source: null,
  confirmedAt: null
}
const confirmedBy = (source: ChatAgeSource): ChatAge => ({
  confirmed: true,
  source,
  confirmedAt: '2027-04-12T12:00:00.000Z'
})

/** The client's two chat age calls, with what they were asked. */
function fakeClient(options: {
  read?: () => Promise<ChatAge>
  write?: (source: ChatAgeSource) => Promise<ChatAge>
  /** What a phone kept from its last read; none by default, as on the web. */
  kept?: ChatAge
  /** When the kept answer is read back; at once by default. */
  keptRead?: Promise<void>
}): { client: TeamStationClient; reads: number[]; writes: ChatAgeSource[] } {
  const reads: number[] = []
  const writes: ChatAgeSource[] = []
  const client = {
    cached: async (key: string) => {
      await options.keptRead
      return key === 'me.chatAge' ? options.kept : undefined
    },
    chatAge: async () => {
      reads.push(reads.length)
      return await (options.read ?? (async () => unconfirmed))()
    },
    confirmChatAge: async (source: ChatAgeSource) => {
      writes.push(source)
      return await (options.write ?? (async () => confirmedBy(source)))(source)
    }
  } as unknown as TeamStationClient
  return { client, reads, writes }
}

/** The state for one person and one Apple answer, with the Shell's sheet. */
function Harness(props: {
  client: TeamStationClient
  userId?: string
  apple: AppleAge
  topKey?: string
  chatSurface?: boolean
  onLeave?: () => void
  seen: { state?: ChatAgeState }
  children?: React.ReactNode
}): React.ReactElement {
  const state = useChatAgeState(props.client, props.userId, props.apple)
  props.seen.state = state
  return (
    <ChatAgeContext.Provider value={state}>
      {props.children}
      <ChatAgeHost
        state={state}
        topKey={props.topKey ?? 'root'}
        chatSurface={props.chatSurface ?? false}
        onLeaveChat={props.onLeave ?? (() => undefined)}
      />
    </ChatAgeContext.Provider>
  )
}

describe('chat age', () => {
  // Inside a describe, so it runs before the shared setup empties the page
  // and an open sheet's portal is still there to take down.
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
  })

  describe('the chat age access', () => {
    const cases: Array<{
      read: 'unconfirmed' | 'confirmed' | 'failed' | 'loading'
      apple: AppleAge
      access: ChatAccess
    }> = [
      { read: 'unconfirmed', apple: 'none', access: 'ask' },
      { read: 'unconfirmed', apple: 'declined', access: 'ask' },
      { read: 'unconfirmed', apple: 'over13', access: 'allowed' },
      { read: 'unconfirmed', apple: 'under13', access: 'blocked' },
      { read: 'unconfirmed', apple: 'pending', access: 'pending' },
      { read: 'confirmed', apple: 'none', access: 'allowed' },
      { read: 'confirmed', apple: 'declined', access: 'allowed' },
      { read: 'confirmed', apple: 'over13', access: 'allowed' },
      { read: 'confirmed', apple: 'under13', access: 'blocked' },
      { read: 'confirmed', apple: 'pending', access: 'pending' },
      { read: 'failed', apple: 'none', access: 'ask' },
      { read: 'failed', apple: 'declined', access: 'ask' },
      { read: 'failed', apple: 'over13', access: 'allowed' },
      { read: 'failed', apple: 'under13', access: 'blocked' },
      { read: 'failed', apple: 'pending', access: 'pending' },
      { read: 'loading', apple: 'none', access: 'pending' },
      { read: 'loading', apple: 'declined', access: 'pending' },
      { read: 'loading', apple: 'over13', access: 'allowed' },
      { read: 'loading', apple: 'under13', access: 'blocked' },
      { read: 'loading', apple: 'pending', access: 'pending' }
    ]
    for (const { read, apple, access } of cases)
      it(`is ${access} for an account read as ${read} with Apple ${apple}`, async () => {
        const { client } = fakeClient({
          read: async () => {
            if (read === 'loading') return await new Promise(() => {})
            if (read === 'failed') throw new TypeError('fetch failed')
            return read === 'confirmed' ? confirmedBy('self') : unconfirmed
          },
          // An Apple confirmation in flight keeps chat open while it saves.
          write: async () => await new Promise(() => {})
        })
        const seen: { state?: ChatAgeState } = {}
        await draw(
          <Harness client={client} userId="usr_a" apple={apple} seen={seen} />
        )
        expect(seen.state?.access).equals(access)
      })

    it('is allowed for nobody signed in, and reads nothing', async () => {
      const { client, reads } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      await draw(<Harness client={client} apple="none" seen={seen} />)
      expect(seen.state?.access).equals('allowed')
      expect(reads).deep.equals([])
    })

    it('answers allowed with no Shell, for a screen drawn alone', async () => {
      let access: ChatAccess | undefined
      function Read(): null {
        access = useChatAge().access
        return null
      }
      await draw(<Read />)
      expect(access).equals('allowed')
    })

    it('confirms an unconfirmed account once from Apple 13 or older, with no sheet', async () => {
      const { client, writes } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="over13"
          chatSurface
          seen={seen}
        />
      )
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="over13"
          chatSurface
          seen={seen}
        />
      )
      expect(writes).deep.equals(['apple'])
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('keeps chat open when an Apple confirmation does not save', async () => {
      const { client, writes } = fakeClient({
        write: async () => {
          throw new TypeError('fetch failed')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="over13" seen={seen} />
      )
      expect(writes).deep.equals(['apple'])
      expect(seen.state?.access).equals('allowed')
    })

    it('reads the account back once Apple\u2019s confirmation lands', async () => {
      const { client, reads, writes } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="over13" seen={seen} />
      )
      expect(writes).deep.equals(['apple'])
      // The first read, then the one a phone keeps the confirmation from.
      expect(reads.length).equals(2)
      expect(seen.state?.access).equals('allowed')
    })

    it('sends Apple\u2019s confirmation again after a failed one, on coming back', async () => {
      let fail = true
      const { client, writes } = fakeClient({
        write: async source => {
          if (fail) throw new TypeError('fetch failed')
          return confirmedBy(source)
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="over13" seen={seen} />
      )
      expect(writes).deep.equals(['apple'])
      fail = false
      await settle(() => {
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(writes).deep.equals(['apple', 'apple'])
      expect(seen.state?.access).equals('allowed')
      // Confirmed now: coming back again sends nothing more.
      await settle(() => {
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(writes).deep.equals(['apple', 'apple'])
    })

    it('reads again for another person, and after a failed read when asked', async () => {
      let fail = true
      const { client, reads } = fakeClient({
        read: async () => {
          if (fail) throw new TypeError('fetch failed')
          return confirmedBy('self')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={seen} />
      )
      expect(seen.state?.failed).equals(true)
      expect(seen.state?.access).equals('ask')
      fail = false
      await settle(() => {
        seen.state?.retry()
      })
      expect(seen.state?.access).equals('allowed')
      await draw(
        <Harness client={client} userId="usr_b" apple="none" seen={seen} />
      )
      expect(reads.length).equals(3)
    })
  })

  describe('the age sheet', () => {
    it('stands over a chat surface, and Not Now leaves it', async () => {
      const { client, writes } = fakeClient({})
      let left = 0
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          onLeave={() => {
            left += 1
          }}
          seen={seen}
        />
      )
      expect(chatAgeSheet()).not.equals(null)
      expect(document.body.textContent).includes('Before You Chat')
      expect(document.body.textContent).includes('13 or Older')
      expect(document.body.textContent).includes('Not Now')
      await settle(() => {
        pressChatAge('decline')
      })
      expect(left).equals(1)
      expect(writes).deep.equals([])
    })

    it('also leaves on the backdrop', async () => {
      const { client } = fakeClient({})
      let left = 0
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          onLeave={() => {
            left += 1
          }}
          seen={seen}
        />
      )
      // The scrim behind the sheet: labelled, but not one of its buttons.
      const scrim = [
        ...document.querySelectorAll<HTMLElement>('[aria-label="Not Now"]')
      ].find(node => node.closest('[data-testid="chat-age-sheet"]') == null)
      expect(scrim).not.equals(undefined)
      await settle(() => {
        scrim!.click()
      })
      expect(left).equals(1)
    })

    it('confirms once on a double press, and leaves when access opens', async () => {
      let release: (() => void) | undefined
      const { client, writes } = fakeClient({
        write: async source =>
          await new Promise(resolve => {
            release = () => {
              resolve(confirmedBy(source))
            }
          })
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="declined"
          chatSurface
          seen={seen}
        />
      )
      await settle(() => {
        pressChatAge('agree')
        pressChatAge('agree')
      })
      expect(writes).deep.equals(['self'])
      await settle(() => {
        release?.()
      })
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('says when an agreement did not save, and stays up', async () => {
      let fail = true
      const { client, writes } = fakeClient({
        write: async source => {
          if (fail) throw new TypeError('fetch failed')
          return confirmedBy(source)
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      await settle(() => {
        pressChatAge('agree')
      })
      expect(document.body.textContent).includes('That didn’t save')
      expect(chatAgeSheet()).not.equals(null)
      fail = false
      await settle(() => {
        pressChatAge('agree')
      })
      expect(writes).deep.equals(['self', 'self'])
      expect(chatAgeSheet()).equals(null)
    })

    it('is only a notice under 13, with no way past it', async () => {
      const { client, writes } = fakeClient({
        read: async () => confirmedBy('self')
      })
      let left = 0
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="under13"
          chatSurface
          onLeave={() => {
            left += 1
          }}
          seen={seen}
        />
      )
      expect(document.body.textContent).includes('Chat Is for Ages 13 and Up')
      expect(document.querySelector('[data-testid="chat-age-agree"]')).equals(
        null
      )
      await settle(() => {
        pressChatAge('ok')
      })
      expect(left).equals(1)
      expect(writes).deep.equals([])
    })

    it('asks the server again when it opens after a failed read', async () => {
      let fail = true
      const { client, reads } = fakeClient({
        read: async () => {
          if (fail) throw new TypeError('fetch failed')
          return confirmedBy('self')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={seen} />
      )
      expect(reads.length).equals(1)
      fail = false
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      expect(reads.length).equals(2)
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('stays still over a failed read, and tries it again once', async () => {
      const { client, reads } = fakeClient({
        read: async () => {
          throw new TypeError('fetch failed')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      expect(chatAgeSheet()).not.equals(null)
      // Sampled while the retry is read and fails: the sheet never closes.
      const shown: boolean[] = []
      await settle(async () => {
        for (let sample = 0; sample < 15; sample++) {
          shown.push(chatAgeSheet() != null)
          await delay(20)
        }
      })
      expect(shown).not.includes(false)
      // The first read, and the one retry the sheet asks for: no loop.
      expect(reads.length).equals(2)
      expect(seen.state?.access).equals('ask')
      expect(chatAgeSheet()).not.equals(null)
    })

    it('keeps a confirmation it knows when a later read fails', async () => {
      let fail = false
      const { client, reads } = fakeClient({
        read: async () => {
          if (fail) throw new TypeError('fetch failed')
          return unconfirmed
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      fail = true
      await settle(() => {
        pressChatAge('agree')
      })
      // Agreeing reads the account back (for a phone to keep); that read fails.
      expect(reads.length).equals(2)
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    for (const [kept, access] of [
      [confirmedBy('self'), 'allowed'],
      [unconfirmed, 'pending']
    ] as const)
      it(`is ${access} at once on a phone's kept ${kept.confirmed ? 'confirmation' : 'unconfirmed answer'} while the read waits`, async () => {
        const { client } = fakeClient({
          read: async () => await new Promise(() => {}),
          kept
        })
        const seen: { state?: ChatAgeState } = {}
        await draw(
          <Harness client={client} userId="usr_a" apple="none" seen={seen} />
        )
        expect(seen.state?.access).equals(access)
      })

    it('draws no sheet for a phone\u2019s kept unconfirmed answer the server finds confirmed', async () => {
      let release: (() => void) | undefined
      const { client } = fakeClient({
        read: async () =>
          await new Promise(resolve => {
            release = () => {
              resolve(confirmedBy('self'))
            }
          }),
        kept: unconfirmed
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      await settle(async () => {
        await delay(50)
      })
      expect(seen.state?.access).equals('pending')
      expect(chatAgeSheet()).equals(null)
      await settle(() => {
        release?.()
      })
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('lets a phone\u2019s kept confirmation stand over a read that failed first', async () => {
      let release: (() => void) | undefined
      const { client } = fakeClient({
        read: async () => {
          throw new HttpError('unavailable', 'Service Unavailable')
        },
        kept: confirmedBy('self'),
        keptRead: new Promise(resolve => {
          release = resolve
        })
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      // The server answered with an error before the phone's own copy.
      expect(seen.state?.failed).equals(true)
      await settle(() => {
        release?.()
      })
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('reads the account again on coming back to the foreground until it is confirmed', async () => {
      let answer = unconfirmed
      const { client, reads } = fakeClient({ read: async () => answer })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={seen} />
      )
      expect(seen.state?.access).equals('ask')
      // Confirmed on another device meanwhile.
      answer = confirmedBy('self')
      await settle(() => {
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(reads.length).equals(2)
      expect(seen.state?.access).equals('allowed')
      // Confirmed now: coming back again reads nothing more.
      await settle(() => {
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(reads.length).equals(2)
    })

    it('draws nothing while pending', async () => {
      const { client } = fakeClient({
        read: async () => await new Promise(() => {})
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          seen={seen}
        />
      )
      expect(seen.state?.access).equals('pending')
      expect(chatAgeSheet()).equals(null)
    })
  })

  describe('a screen asking for the sheet', () => {
    function Asker(props: {
      onDecline: () => void
      onAgreed?: () => void
      cancel: { current?: () => void }
      testID?: string
    }): React.ReactElement {
      const ask = useChatAgeAsk()
      return (
        <button
          type="button"
          data-testid={props.testID ?? 'ask'}
          onClick={() => {
            props.cancel.current = ask({
              onDecline: props.onDecline,
              onAgreed: props.onAgreed
            })
          }}
        />
      )
    }
    const press = async (testID = 'ask'): Promise<void> => {
      await settle(() => {
        document
          .querySelector<HTMLElement>(`[data-testid="${testID}"]`)
          ?.click()
      })
    }

    it('is drawn only while the scene that asked is on top', async () => {
      const { client } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      const cancel: { current?: () => void } = {}
      const scene = (topKey: string): React.ReactElement => (
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          topKey={topKey}
          seen={seen}
        >
          <ChatFrameKey.Provider value="team">
            <Asker onDecline={() => undefined} cancel={cancel} />
          </ChatFrameKey.Provider>
        </Harness>
      )
      await draw(scene('team'))
      await press()
      expect(chatAgeSheet()).not.equals(null)
      // A frame pushed over it: its sheet waits.
      await draw(scene('game'))
      expect(chatAgeSheet()).equals(null)
      await draw(scene('team'))
      expect(chatAgeSheet()).not.equals(null)
      await settle(() => {
        cancel.current?.()
      })
      expect(chatAgeSheet()).equals(null)
      expect(seen.state?.requests).deep.equals({})
    })

    it('runs Not Now or the agreement once, then clears the request', async () => {
      const { client } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      const cancel: { current?: () => void } = {}
      const told: string[] = []
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={seen}>
          <Asker
            onDecline={() => told.push('decline')}
            onAgreed={() => told.push('agreed')}
            cancel={cancel}
          />
        </Harness>
      )
      await press()
      await settle(() => {
        pressChatAge('decline')
      })
      expect(told).deep.equals(['decline'])
      expect(seen.state?.requests).deep.equals({})
      await press()
      // A later request replaces the one before; cancelling the old one keeps it.
      const first = cancel.current
      await press()
      await settle(() => {
        first?.()
      })
      expect(chatAgeSheet()).not.equals(null)
      await settle(() => {
        pressChatAge('agree')
      })
      expect(told).deep.equals(['decline', 'agreed'])
      expect(seen.state?.requests).deep.equals({})
      expect(chatAgeSheet()).equals(null)
    })

    for (const way of ['Not Now', 'the backdrop'] as const)
      it(`withdraws an agreement still saving on ${way}, opening nothing when it lands`, async () => {
        let release: (() => void) | undefined
        const { client, writes } = fakeClient({
          write: async source =>
            await new Promise(resolve => {
              release = () => {
                resolve(confirmedBy(source))
              }
            })
        })
        const told: string[] = []
        const seen: { state?: ChatAgeState } = {}
        const cancel: { current?: () => void } = {}
        await draw(
          <Harness client={client} userId="usr_a" apple="none" seen={seen}>
            <Asker
              onDecline={() => told.push('decline')}
              onAgreed={() => told.push('agreed')}
              cancel={cancel}
            />
          </Harness>
        )
        await press()
        await settle(() => {
          pressChatAge('agree')
        })
        await settle(() => {
          if (way === 'Not Now') pressChatAge('decline')
          else
            [
              ...document.querySelectorAll<HTMLElement>(
                '[aria-label="Not Now"]'
              )
            ]
              .find(
                node => node.closest('[data-testid="chat-age-sheet"]') == null
              )
              ?.click()
        })
        expect(told).deep.equals(['decline'])
        expect(chatAgeSheet()).equals(null)
        await settle(() => {
          release?.()
        })
        // It saved: chat is open from now on, but nothing was opened for it.
        expect(writes).deep.equals(['self'])
        expect(told).deep.equals(['decline'])
        expect(seen.state?.access).equals('allowed')
      })

    for (const way of [
      'its frame leaving the top',
      'its screen going'
    ] as const)
      it(`withdraws an agreement still saving on ${way}, opening nothing when it lands`, async () => {
        let release: (() => void) | undefined
        const { client, writes } = fakeClient({
          write: async source =>
            await new Promise(resolve => {
              release = () => {
                resolve(confirmedBy(source))
              }
            })
        })
        const told: string[] = []
        const seen: { state?: ChatAgeState } = {}
        const cancel: { current?: () => void } = {}
        const scene = (topKey: string): React.ReactElement => (
          <Harness
            client={client}
            userId="usr_a"
            apple="none"
            topKey={topKey}
            seen={seen}
          >
            <ChatFrameKey.Provider value="team">
              <Asker
                onDecline={() => told.push('decline')}
                onAgreed={() => told.push('agreed')}
                cancel={cancel}
              />
            </ChatFrameKey.Provider>
          </Harness>
        )
        await draw(scene('team'))
        await press()
        await settle(() => {
          pressChatAge('agree')
        })
        if (way === 'its frame leaving the top') await draw(scene('game'))
        else
          await settle(() => {
            cancel.current?.()
          })
        expect(chatAgeSheet()).equals(null)
        await settle(() => {
          release?.()
        })
        expect(writes).deep.equals(['self'])
        expect(told).deep.equals([])
        expect(seen.state?.access).equals('allowed')
      })

    it('opens free of an agreement withdrawn while it still saves', async () => {
      const { client } = fakeClient({
        write: async () => await new Promise(() => {})
      })
      const cancel: { current?: () => void } = {}
      const seen: { state?: ChatAgeState } = {}
      const scene = (topKey: string): React.ReactElement => (
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          topKey={topKey}
          seen={seen}
        >
          <ChatFrameKey.Provider value="team">
            <Asker onDecline={() => undefined} cancel={cancel} />
          </ChatFrameKey.Provider>
        </Harness>
      )
      await draw(scene('team'))
      await press()
      await settle(() => {
        pressChatAge('agree')
      })
      const agree = (): string | null | undefined =>
        document
          .querySelector<HTMLElement>('[data-testid="chat-age-agree"]')
          ?.getAttribute('aria-disabled')
      expect(agree()).equals('true')
      await draw(scene('game'))
      await draw(scene('team'))
      expect(chatAgeSheet()).not.equals(null)
      expect(agree()).not.equals('true')
    })

    it('opens again with no error from an earlier opening', async () => {
      const { client } = fakeClient({
        write: async () => {
          throw new TypeError('fetch failed')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      const cancel: { current?: () => void } = {}
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={seen}>
          <Asker onDecline={() => undefined} cancel={cancel} />
        </Harness>
      )
      await press()
      await settle(() => {
        pressChatAge('agree')
      })
      expect(document.body.textContent).includes('That didn’t save')
      await settle(() => {
        pressChatAge('decline')
      })
      expect(chatAgeSheet()).equals(null)
      await press()
      expect(chatAgeSheet()).not.equals(null)
      expect(document.body.textContent).not.includes('That didn’t save')
    })

    it('keeps each frame’s own request, and draws the one on top', async () => {
      const { client } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      const lower: { current?: () => void } = {}
      const upper: { current?: () => void } = {}
      const told: string[] = []
      const scene = (topKey: string): React.ReactElement => (
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          topKey={topKey}
          seen={seen}
        >
          <ChatFrameKey.Provider value="team">
            <Asker
              testID="ask-team"
              onDecline={() => told.push('team')}
              cancel={lower}
            />
          </ChatFrameKey.Provider>
          <ChatFrameKey.Provider value="season">
            <Asker
              testID="ask-season"
              onDecline={() => told.push('season')}
              cancel={upper}
            />
          </ChatFrameKey.Provider>
        </Harness>
      )
      await draw(scene('team'))
      await press('ask-team')
      await draw(scene('season'))
      await press('ask-season')
      expect(Object.keys(seen.state?.requests ?? {}).sort()).deep.equals([
        'season',
        'team'
      ])
      // The season frame goes: its request with it; the team's stays and shows.
      await settle(() => {
        upper.current?.()
      })
      await draw(scene('team'))
      expect(chatAgeSheet()).not.equals(null)
      await settle(() => {
        pressChatAge('decline')
      })
      expect(told).deep.equals(['team'])
    })
  })

  describe('the sheet alone', () => {
    it('shows its buttons busy while the agreement saves', async () => {
      let agreed = 0
      await draw(
        <ChatAgeSheet
          mode="consent"
          busy
          onAgree={() => {
            agreed += 1
          }}
          onDecline={() => undefined}
        />
      )
      const agree = document.querySelector<HTMLElement>(
        '[data-testid="chat-age-agree"]'
      )
      expect(agree?.getAttribute('aria-disabled')).equals('true')
      expect(agreed).equals(0)
    })
  })
})
