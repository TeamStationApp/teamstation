import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AgeView } from '../../common/age'
import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { chatAgeSheet, pressChatAge } from '../../test/chatAgeTesting'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  type ChatAccess,
  ChatAgeContext,
  ChatAgeHost,
  type ChatAgeState,
  ChatFrameKey,
  useChatAge,
  useChatAgeAsk,
  useChatAgeState
} from './AgeGate'
import { AgeSheet } from './AgeSheet'
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

const unconfirmed: AgeView = {
  band: 'unknown',
  birthYear: null,
  birthMonth: null,
  isAdult: false,
  ageSource: null,
  ageSetAt: null
}
/** An adult who answered by `source`. */
const confirmedBy = (source: 'self' | 'apple'): AgeView => ({
  band: 'adult',
  birthYear: null,
  birthMonth: null,
  isAdult: true,
  ageSource: source,
  ageSetAt: '2027-04-12T12:00:00.000Z'
})
const bandOf = (band: AgeView['band']): AgeView => ({
  ...unconfirmed,
  band,
  ageSource: 'self',
  ageSetAt: '2027-04-12T12:00:00.000Z'
})
const APPLE_ADULT: AppleAge = { kind: 'adult', lowerBound: 18 }
const APPLE_UNDER13: AppleAge = { kind: 'under13' }
const APPLE_TEEN: AppleAge = { kind: 'minor', lowerBound: 13, upperBound: 15 }

/** What the modal sent: `apple` for Apple's own answer, else the body. */
type Write = 'self' | 'apple' | Record<string, unknown>

/** The client's two age calls, with what they were asked. */
function fakeClient(options: {
  read?: () => Promise<AgeView>
  write?: (source: 'self' | 'apple', body: unknown) => Promise<AgeView>
  /** What a phone kept from its last read; none by default, as on the web. */
  kept?: AgeView
  /** When the kept answer is read back; at once by default. */
  keptRead?: Promise<void>
}): {
  client: TeamStationClient
  reads: number[]
  writes: Write[]
  bodies: unknown[]
} {
  const reads: number[] = []
  const writes: Write[] = []
  const bodies: unknown[] = []
  // With no `read` given, the server reads back what it last saved.
  let saved: AgeView | undefined
  const client = {
    cached: async (key: string) => {
      await options.keptRead
      return key === 'me.age' ? options.kept : undefined
    },
    myAge: async () => {
      reads.push(reads.length)
      return await (options.read ?? (async () => saved ?? unconfirmed))()
    },
    setMyAge: async (body: { apple?: unknown; adult?: true }) => {
      const source =
        body.apple != null && body.adult == null && !('year' in body)
          ? 'apple'
          : 'self'
      writes.push(source)
      bodies.push(body)
      const age = await (
        options.write ?? (async (from: 'self' | 'apple') => confirmedBy(from))
      )(source, body)
      saved = age
      return age
    }
  } as unknown as TeamStationClient
  return { client, reads, writes, bodies }
}

/** The state for one person and one Apple answer, with the Shell's sheet. */
function Harness(props: {
  client: TeamStationClient
  userId?: string
  apple: AppleAge
  topKey?: string
  chatSurface?: boolean
  onLeave?: () => void
  onAnswered?: () => void
  seen: { state?: ChatAgeState }
  children?: React.ReactNode
}): React.ReactElement {
  const state = useChatAgeState(
    props.client,
    props.userId,
    props.apple,
    props.onAnswered
  )
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
      { read: 'unconfirmed', apple: APPLE_ADULT, access: 'pending' },
      { read: 'unconfirmed', apple: APPLE_UNDER13, access: 'blocked' },
      { read: 'unconfirmed', apple: 'pending', access: 'pending' },
      { read: 'confirmed', apple: 'none', access: 'allowed' },
      { read: 'confirmed', apple: 'declined', access: 'allowed' },
      { read: 'confirmed', apple: APPLE_ADULT, access: 'allowed' },
      { read: 'confirmed', apple: APPLE_UNDER13, access: 'blocked' },
      { read: 'confirmed', apple: 'pending', access: 'pending' },
      { read: 'failed', apple: 'none', access: 'ask' },
      { read: 'failed', apple: 'declined', access: 'ask' },
      { read: 'failed', apple: APPLE_ADULT, access: 'pending' },
      { read: 'failed', apple: APPLE_UNDER13, access: 'blocked' },
      { read: 'failed', apple: 'pending', access: 'pending' },
      { read: 'loading', apple: 'none', access: 'pending' },
      { read: 'loading', apple: 'declined', access: 'pending' },
      { read: 'loading', apple: APPLE_ADULT, access: 'pending' },
      { read: 'loading', apple: APPLE_UNDER13, access: 'blocked' },
      { read: 'loading', apple: 'pending', access: 'pending' }
    ]
    for (const { read, apple, access } of cases)
      it(`is ${access} for an account read as ${read} with Apple ${JSON.stringify(apple)}`, async () => {
        const { client } = fakeClient({
          read: async () => {
            if (read === 'loading') return await new Promise(() => {})
            if (read === 'failed') throw new TypeError('fetch failed')
            return read === 'confirmed' ? confirmedBy('self') : unconfirmed
          },
          // An Apple confirmation in flight holds chat (`pending`) until it lands.
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
          apple={APPLE_ADULT}
          chatSurface
          seen={seen}
        />
      )
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_ADULT}
          chatSurface
          seen={seen}
        />
      )
      expect(writes).deep.equals(['apple'])
      expect(seen.state?.access).equals('allowed')
      expect(chatAgeSheet()).equals(null)
    })

    it('holds chat, with no modal, while an Apple confirmation does not save', async () => {
      const { client, writes } = fakeClient({
        write: async () => {
          throw new TypeError('fetch failed')
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_ADULT}
          seen={seen}
        />
      )
      expect(writes).deep.equals(['apple'])
      expect(seen.state?.access).equals('pending')
      expect(chatAgeSheet()).equals(null)
    })

    it('reads the account back once Apple\u2019s confirmation lands', async () => {
      const { client, reads, writes } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_ADULT}
          seen={seen}
        />
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
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_ADULT}
          seen={seen}
        />
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
    it('stands over a chat surface, and closing it leaves', async () => {
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
      const text = document.body.textContent ?? ''
      expect(text).includes('Your Age')
      expect(text).includes('Chat features depend on your age.')
      expect(text).includes('Enter Birth Year and Month')
      expect(text).includes('I’m 18 or Older')
      expect(text).includes('keep chat respectful')
      // The two buttons, in that order, above the rules.
      expect(text.indexOf('Enter Birth Year and Month')).lessThan(
        text.indexOf('I’m 18 or Older')
      )
      expect(text.indexOf('I’m 18 or Older')).lessThan(
        text.indexOf('keep chat respectful')
      )
      await settle(() => {
        pressChatAge('close')
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
        ...document.querySelectorAll<HTMLElement>('[aria-label="Close"]')
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
        pressChatAge('adult')
        pressChatAge('adult')
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
        pressChatAge('adult')
      })
      expect(document.body.textContent).includes('That didn’t save')
      expect(chatAgeSheet()).not.equals(null)
      fail = false
      await settle(() => {
        pressChatAge('adult')
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
          apple={APPLE_UNDER13}
          chatSurface
          onLeave={() => {
            left += 1
          }}
          seen={seen}
        />
      )
      expect(document.body.textContent).includes('Chat Is for Ages 13 and Up')
      expect(document.querySelector('[data-testid="chat-age-adult"]')).equals(
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
        pressChatAge('adult')
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
      it(`is ${access} at once on a phone's kept ${kept.band === 'adult' ? 'adult band' : 'unknown age'} while the read waits`, async () => {
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

    it('runs closing or the answer once, then clears the request', async () => {
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
        pressChatAge('close')
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
        pressChatAge('adult')
      })
      expect(told).deep.equals(['decline', 'agreed'])
      expect(seen.state?.requests).deep.equals({})
      expect(chatAgeSheet()).equals(null)
    })

    for (const way of ['Close', 'the backdrop'] as const)
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
          pressChatAge('adult')
        })
        await settle(() => {
          if (way === 'Close') pressChatAge('close')
          else
            [...document.querySelectorAll<HTMLElement>('[aria-label="Close"]')]
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
          pressChatAge('adult')
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
        pressChatAge('adult')
      })
      const agree = (): string | null | undefined =>
        document
          .querySelector<HTMLElement>('[data-testid="chat-age-adult"]')
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
        pressChatAge('adult')
      })
      expect(document.body.textContent).includes('That didn’t save')
      await settle(() => {
        pressChatAge('close')
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
        pressChatAge('close')
      })
      expect(told).deep.equals(['team'])
    })
  })

  describe('the age modal’s answers', () => {
    /** Types into one of the modal's fields as a person would. */
    const type = async (testId: string, value: string): Promise<void> => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-testid="${testId}"]`
      )!
      await settle(() => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    const saveDisabled = (): string | null | undefined =>
      document
        .querySelector('[data-testid="chat-age-save"]')
        ?.getAttribute('aria-disabled')

    for (const [band, access] of [
      ['minor', 'allowed'],
      ['adult', 'allowed'],
      ['under13', 'blocked'],
      ['unknown', 'ask']
    ] as const) {
      it(`is ${access} for a band of ${band}`, async () => {
        const { client } = fakeClient({ read: async () => bandOf(band) })
        const seen: { state?: ChatAgeState } = {}
        await draw(
          <Harness client={client} userId="usr_a" apple="none" seen={seen} />
        )
        expect(seen.state?.access).equals(access)
      })
    }

    it('takes a year first and then a month, numeric fields, each checked before Save', async () => {
      const now = new Date()
      let answered = 0
      const { client, bodies } = fakeClient({
        write: async () => bandOf('minor')
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          onAnswered={() => {
            answered += 1
          }}
          seen={seen}
        />
      )
      await settle(() => {
        pressChatAge('enter')
      })
      const fields = [
        ...document.querySelectorAll<HTMLInputElement>(
          '[data-testid="chat-age-sheet"] input'
        )
      ]
      expect(fields.map(field => field.dataset.testid)).deep.equals([
        'chat-age-year',
        'chat-age-month'
      ])
      for (const field of fields) {
        expect(field.getAttribute('inputmode')).equals('numeric')
        expect(field.getAttribute('pattern')).equals('[0-9]*')
        expect(field.getAttribute('type')).not.equals('number')
      }
      expect(saveDisabled()).equals('true')
      await type('chat-age-year', '202')
      await type('chat-age-month', '6')
      expect(saveDisabled()).equals('true')
      await type('chat-age-year', String(now.getUTCFullYear() - 14))
      for (const month of ['0', '13']) {
        await type('chat-age-month', month)
        expect(saveDisabled(), month).equals('true')
      }
      expect(document.body.textContent).includes('a month from 1 to 12')
      // Letters are dropped; a date in the future is refused.
      await type('chat-age-year', `${now.getUTCFullYear() + 1}x`)
      await type('chat-age-month', '1')
      expect(saveDisabled()).equals('true')
      await type('chat-age-year', String(now.getUTCFullYear() - 14))
      expect(saveDisabled()).not.equals('true')
      await settle(() => {
        pressChatAge('save')
      })
      expect(bodies).deep.equals([
        { year: now.getUTCFullYear() - 14, month: 1 }
      ])
      expect(seen.state?.access).equals('allowed')
      expect(answered).equals(1)
    })

    it('shows the notice after an answer under 13, and goes back from the fields', async () => {
      const { client } = fakeClient({ write: async () => bandOf('under13') })
      const seen: { state?: ChatAgeState } = {}
      let left = 0
      let answered = 0
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          onLeave={() => {
            left += 1
          }}
          onAnswered={() => {
            answered += 1
          }}
          seen={seen}
        />
      )
      await settle(() => {
        pressChatAge('enter')
      })
      await settle(() => {
        pressChatAge('back')
      })
      expect(document.querySelector('[data-testid="chat-age-year"]')).equals(
        null
      )
      await settle(() => {
        pressChatAge('enter')
      })
      await type('chat-age-year', String(new Date().getUTCFullYear() - 10))
      await type('chat-age-month', '1')
      await settle(() => {
        pressChatAge('save')
      })
      expect(seen.state?.access).equals('blocked')
      expect(document.body.textContent).includes('Chat Is for Ages 13 and Up')
      expect(answered).equals(0)
      await settle(() => {
        pressChatAge('ok')
      })
      expect(left).equals(1)
    })

    it('saves Apple’s 18 or older with no modal', async () => {
      const { client, bodies } = fakeClient({})
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_ADULT}
          chatSurface
          seen={seen}
        />
      )
      expect(chatAgeSheet()).equals(null)
      expect(seen.state?.access).equals('allowed')
      expect(bodies).deep.equals([{ apple: { lowerBound: 18 } }])
    })

    it('under Apple’s 13 to 15, offers no 18 or older and refuses dates outside the range', async () => {
      const now = new Date()
      const { client, bodies } = fakeClient({
        write: async () => bandOf('minor')
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_TEEN}
          chatSurface
          seen={seen}
        />
      )
      expect(document.querySelector('[data-testid="chat-age-adult"]')).equals(
        null
      )
      const sheet = document.querySelector('[data-testid="chat-age-sheet"]')
      expect(sheet?.textContent).includes(lstrings.chat_age_body_minor)
      expect(sheet?.textContent).not.includes(lstrings.chat_age_body)
      await settle(() => {
        pressChatAge('enter')
      })
      // 17, then 14, by January's birth month.
      await type('chat-age-year', String(now.getUTCFullYear() - 18))
      await type('chat-age-month', '1')
      expect(saveDisabled()).equals('true')
      await type('chat-age-year', String(now.getUTCFullYear() - 15))
      expect(saveDisabled()).not.equals('true')
      await settle(() => {
        pressChatAge('save')
      })
      expect(bodies).deep.equals([
        {
          year: now.getUTCFullYear() - 15,
          month: 1,
          apple: { lowerBound: 13, upperBound: 15 }
        }
      ])
    })

    it('shows only the notice under Apple’s under 13', async () => {
      const { client } = fakeClient({})
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple={APPLE_UNDER13}
          chatSurface
          seen={{}}
        />
      )
      expect(document.body.textContent).includes('Chat Is for Ages 13 and Up')
      expect(document.querySelector('[data-testid="chat-age-enter"]')).equals(
        null
      )
    })

    it('reads the band again when a chat call is refused for want of an age', async () => {
      const { client, reads } = fakeClient({})
      await draw(
        <Harness client={client} userId="usr_a" apple="none" seen={{}} />
      )
      const before = reads.length
      const told = (client as unknown as { onAgeRequired?: () => void })
        .onAgeRequired
      expect(told).not.equals(undefined)
      await settle(() => {
        told?.()
      })
      expect(reads.length).equals(before + 1)
      await act(async () => root?.unmount())
      root = undefined
      expect(
        (client as unknown as { onAgeRequired?: () => void }).onAgeRequired
      ).equals(undefined)
    })
    it('takes an age an administrator cleared, and reconnects when an answer arrives from elsewhere', async () => {
      let band: AgeView['band'] = 'minor'
      let answered = 0
      const { client } = fakeClient({ read: async () => bandOf(band) })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          onAnswered={() => {
            answered += 1
          }}
          seen={seen}
        />
      )
      expect(seen.state?.access).equals('allowed')
      // Read as 13 to 17 from the start: the socket heard chat already.
      expect(answered).equals(0)
      const told = (): void =>
        (client as unknown as { onAgeRequired?: () => void }).onAgeRequired?.()
      band = 'unknown'
      await settle(told)
      expect(seen.state?.access).equals('ask')
      band = 'adult'
      await settle(told)
      expect(seen.state?.access).equals('allowed')
      expect(answered).equals(1)
    })

    it('keeps its own answer over a read asked before it', async () => {
      let read = 0
      let late: ((age: AgeView) => void) | undefined
      const { client } = fakeClient({
        read: async () => {
          read += 1
          if (read === 1) return unconfirmed
          if (read === 2)
            return await new Promise<AgeView>(resolve => {
              late = resolve
            })
          return confirmedBy('self')
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
      expect(seen.state?.access).equals('ask')
      await settle(() => {
        ;(client as unknown as { onAgeRequired?: () => void }).onAgeRequired?.()
      })
      await settle(() => {
        pressChatAge('adult')
      })
      expect(seen.state?.access).equals('allowed')
      await settle(() => {
        late?.(unconfirmed)
      })
      expect(seen.state?.access).equals('allowed')
    })

    it('takes the account’s age when it was already set elsewhere', async () => {
      let answered = 0
      let read = 0
      const { client } = fakeClient({
        read: async () => {
          read += 1
          return read === 1 ? unconfirmed : bandOf('minor')
        },
        write: async () => {
          throw new HttpError('conflict', 'Your age is already set', {
            reason: 'ageSet'
          })
        }
      })
      const seen: { state?: ChatAgeState } = {}
      await draw(
        <Harness
          client={client}
          userId="usr_a"
          apple="none"
          chatSurface
          onAnswered={() => {
            answered += 1
          }}
          seen={seen}
        />
      )
      await settle(() => {
        pressChatAge('adult')
      })
      expect(seen.state?.access).equals('allowed')
      expect(document.body.textContent).not.includes(lstrings.chat_age_failed)
      expect(document.querySelector('[data-testid="chat-age-sheet"]')).equals(
        null
      )
      expect(answered).equals(1)
    })
  })

  describe('the modal alone', () => {
    it('shows its buttons busy while an answer saves', async () => {
      const answers: unknown[] = []
      await draw(
        <AgeSheet
          mode="ask"
          apple="none"
          busy
          onAnswer={body => answers.push(body)}
          onDecline={() => undefined}
        />
      )
      const adult = document.querySelector<HTMLElement>(
        '[data-testid="chat-age-adult"]'
      )
      expect(adult?.getAttribute('aria-disabled')).equals('true')
      expect(answers).deep.equals([])
    })

    it('leaves out 18 or older under an Apple answer of 13 to 17', async () => {
      await draw(
        <AgeSheet
          mode="ask"
          apple={APPLE_TEEN}
          onAnswer={() => undefined}
          onDecline={() => undefined}
        />
      )
      expect(document.querySelector('[data-testid="chat-age-adult"]')).equals(
        null
      )
      expect(
        document.querySelector('[data-testid="chat-age-enter"]')
      ).not.equals(null)
    })
  })
})
