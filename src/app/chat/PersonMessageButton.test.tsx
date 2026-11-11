import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asChatConversation,
  type ChatConversation,
  type ChatPerson,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { chatAgeRecord, TestChatAge } from '../../test/chatAgeTesting'
import { SceneShownProvider } from '../components/sceneShown'
import { ThemeProvider } from '../theme/ThemeContext'
import { chat } from './chatViews.test.helpers'
import { PersonMessageButton } from './PersonMessageButton'

let root: Root | undefined
const person: ChatPerson = {
  userId: 'usr_recipient',
  shortName: 'Mike T',
  avatarUrl: null,
  affiliations: ''
}
const conversation = asChatConversation(
  chat({ id: 'cnv_direct', title: 'Mike T' })
)
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
const message = (): HTMLElement | null =>
  document.querySelector('[data-testid="person-message"]')
const words = (): string => document.body.textContent ?? ''
const sheet = (): HTMLElement | null =>
  document.querySelector('[data-testid="chat-age-sheet"]')
const agree = (): HTMLElement | null =>
  document.querySelector('[data-testid="chat-age-agree"]')
const decline = (): HTMLElement | null =>
  document.querySelector('[data-testid="chat-age-decline"]')
const ok = (): HTMLElement | null =>
  document.querySelector('[data-testid="chat-age-ok"]')
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let complete!: (value: T) => void
  let fail!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  return { promise, resolve: complete, reject: fail }
}
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action()
    await delay()
  })
}
async function render(
  client: Partial<TeamStationClient>,
  onOpenChat: (chat: {
    id: string
    title: string
  }) => void | Promise<void> = () => {},
  userId = person.userId
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await settle(() => {
    root!.render(
      <ThemeProvider>
        <PersonMessageButton
          client={client as TeamStationClient}
          userId={userId}
          onOpenChat={onOpenChat}
        />
      </ThemeProvider>
    )
  })
}
afterEach(async function () {
  await settle(() => root?.unmount())
  root = undefined
})

describe('the person Message hero action', function () {
  it('waits for exact eligibility and hides unavailable recipients or failed lookups', async function () {
    const lookup = deferred<ChatPerson[]>()
    const client = {
      dmCandidates: async (query?: string, userId?: string) => {
        expect([query, userId]).deep.equals(['', person.userId])
        return await lookup.promise
      }
    }
    await render(client)
    expect(message()).equals(null)
    await settle(() => {
      lookup.resolve([person])
    })
    expect(message()).not.equals(null)
    await render({ dmCandidates: async () => [] })
    expect(message()).equals(null)
    await render({
      dmCandidates: async () => [{ ...person, userId: 'usr_someone_else' }]
    })
    expect(message()).equals(null)
    await render({
      dmCandidates: async () => {
        throw new Error('offline')
      }
    })
    expect(message()).equals(null)
  })

  it('opens the exact conversation and prevents duplicates while creation and navigation finish', async function () {
    const created = deferred<ChatConversation>()
    const navigated = deferred<undefined>()
    const calls: string[][] = []
    const opened: unknown[] = []
    await render(
      {
        dmCandidates: async () => [person],
        createDm: async ids => {
          calls.push(ids)
          return await created.promise
        }
      },
      async chat => {
        opened.push(chat)
        await navigated.promise
      }
    )
    await settle(() => {
      message()!.click()
      message()!.click()
    })
    expect(calls).deep.equals([[person.userId]])
    await settle(() => {
      created.resolve(conversation)
    })
    expect(opened).deep.equals([
      { id: conversation.id, title: conversation.title }
    ])
    await settle(() => {
      message()!.click()
    })
    expect(calls).length(1)
    await settle(() => {
      navigated.resolve(undefined)
    })
    expect(message()!.getAttribute('aria-disabled')).not.equals('true')
  })

  it('keeps failed creation retryable, including malformed adult requirements', async function () {
    const failures = [
      new Error('offline'),
      new HttpError('forbidden', 'Include an adult', {
        reason: 'adultRequired',
        playerIds: []
      }),
      new HttpError('forbidden', 'Include an adult', {
        reason: 'adultRequired',
        playerIds: [4]
      })
    ]
    let calls = 0
    let opened = false
    await render(
      {
        dmCandidates: async () => [person],
        createDm: async () => {
          if (calls < failures.length) throw failures[calls++]
          return { ...conversation, title: null }
        }
      },
      chat => {
        expect(chat.title).equals('')
        opened = true
      }
    )
    for (const ignored of failures) {
      expect(ignored).not.equals(undefined)
      await settle(() => {
        message()!.click()
      })
      expect(document.querySelector('[role="alert"]')).not.equals(null)
      expect(message()!.getAttribute('aria-disabled')).not.equals('true')
    }
    await settle(() => {
      message()!.click()
    })
    expect(opened).equals(true)
    expect(document.querySelector('[role="alert"]')).equals(null)
  })

  it('ignores old eligibility and creation after changing people or leaving', async function () {
    const lookup = deferred<ChatPerson[]>()
    await render({ dmCandidates: async () => await lookup.promise })
    await render({ dmCandidates: async () => [] }, undefined, 'usr_other')
    await settle(() => {
      lookup.resolve([person])
    })
    expect(message()).equals(null)
    for (const reject of [false, true]) {
      const created = deferred<ChatConversation>()
      let opened = false
      await render(
        {
          dmCandidates: async () => [person],
          createDm: async () => await created.promise
        },
        () => {
          opened = true
        }
      )
      await settle(() => {
        message()!.click()
      })
      await settle(() => root?.unmount())
      root = undefined
      await settle(() => {
        if (reject) created.reject(new Error('offline'))
        else created.resolve(conversation)
      })
      expect(opened).equals(false)
    }
  })

  it('lets the user include a required adult or cancel the choice', async function () {
    const calls: string[][] = []
    let opened = false
    let adultFailure = true
    await render(
      {
        dmCandidates: async () => [person],
        createDm: async ids => {
          calls.push(ids)
          if (ids.length === 1)
            throw new HttpError('forbidden', 'Include an adult', {
              reason: 'adultRequired',
              playerIds: [person.userId]
            })
          if (adultFailure) {
            adultFailure = false
            throw new Error('offline')
          }
          return conversation
        },
        includedAdults: async () => [
          { userId: 'usr_adult', shortName: 'Aaron J', label: 'Guardian' }
        ]
      },
      () => {
        opened = true
      }
    )
    const clickText = (text: string): void => {
      const target = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node => node.textContent === text)
      expect(target, text).not.equals(undefined)
      target!.click()
    }
    await settle(() => {
      message()!.click()
    })
    await settle()
    expect(words()).contains('Aaron J')
    await settle(() => {
      clickText('Cancel')
    })
    expect(words()).not.contains('Aaron J')
    await settle(() => {
      message()!.click()
    })
    await settle()
    await settle(() => {
      clickText('Aaron JGuardian')
    })
    await settle(() => {
      clickText('Start with them')
    })
    expect(opened).equals(false)
    expect(words()).not.contains('Aaron J')
    expect(document.querySelector('[role="alert"]')).not.equals(null)
    await settle(() => {
      message()!.click()
    })
    await settle()
    await settle(() => {
      clickText('Aaron JGuardian')
    })
    await settle(() => {
      clickText('Start with them')
    })
    expect(calls.at(-1)).deep.equals([person.userId, 'usr_adult'])
    expect(opened).equals(true)
  })

  for (const blocked of [false, true])
    it(`draws Message ${blocked ? 'under 13 and makes no DM past the notice' : 'before the age sheet and makes no DM until it is agreed to'}`, async () => {
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      const record = chatAgeRecord()
      const made: string[][] = []
      const opened: string[] = []
      const client = {
        dmCandidates: async () => [person],
        createDm: async (ids: string[]) => {
          made.push(ids)
          return conversation
        }
      } as unknown as TeamStationClient
      await settle(() => {
        root!.render(
          <ThemeProvider>
            <TestChatAge access={blocked ? 'blocked' : 'ask'} record={record}>
              <PersonMessageButton
                client={client}
                userId={person.userId}
                onOpenChat={chat => {
                  opened.push(chat.id)
                }}
              />
            </TestChatAge>
          </ThemeProvider>
        )
      })
      expect(message()).not.equals(null)
      await settle(() => {
        message()!.click()
      })
      expect(sheet()).not.equals(null)
      if (blocked) {
        expect(words()).includes('Chat Is for Ages 13 and Up')
        expect(agree()).equals(null)
        await settle(() => {
          ok()!.click()
        })
        expect(sheet()).equals(null)
        expect(made).deep.equals([])
        return
      }
      expect(words()).includes('Before You Chat')
      await settle(() => {
        decline()!.click()
      })
      expect(sheet()).equals(null)
      expect(made).deep.equals([])
      expect(record.confirms).equals(0)
      // Asked again on the next press.
      await settle(() => {
        message()!.click()
      })
      expect(sheet()).not.equals(null)
      await settle(() => {
        agree()!.click()
      })
      expect(record.confirms).equals(1)
      expect(sheet()).equals(null)
      expect(made).deep.equals([[person.userId]])
      expect(opened).deep.equals(['cnv_direct'])
      // Agreed once: the next press goes straight to the DM.
      await settle(() => {
        message()!.click()
      })
      expect(sheet()).equals(null)
      expect(made.length).equals(2)
    })

  for (const settled of ['allowed', 'ask'] as const)
    it(`holds a press made while the age answer is pending, then acts when it is ${settled}`, async () => {
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      const made: string[][] = []
      const client = {
        dmCandidates: async () => [person],
        createDm: async (ids: string[]) => {
          made.push(ids)
          return conversation
        }
      } as unknown as TeamStationClient
      const page = (
        access: 'pending' | 'allowed' | 'ask'
      ): React.ReactElement => (
        <ThemeProvider>
          <TestChatAge access={access}>
            <PersonMessageButton
              client={client}
              userId={person.userId}
              onOpenChat={() => undefined}
            />
          </TestChatAge>
        </ThemeProvider>
      )
      await settle(() => {
        root!.render(page('pending'))
      })
      await settle(() => {
        message()!.click()
      })
      expect(sheet()).equals(null)
      expect(made).deep.equals([])
      expect(message()!.getAttribute('aria-disabled')).equals('true')
      await settle(() => {
        root!.render(page(settled))
      })
      if (settled === 'allowed') {
        expect(made).deep.equals([[person.userId]])
        expect(sheet()).equals(null)
      } else {
        expect(made).deep.equals([])
        expect(sheet()).not.equals(null)
        // Closed, so the shared teardown finds no sheet to take down.
        await settle(() => {
          decline()!.click()
        })
        expect(sheet()).equals(null)
      }
    })

  for (const settled of ['allowed', 'ask'] as const)
    it(`drops a press held while pending once its screen is covered, doing nothing when it is ${settled}`, async () => {
      const host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      const made: string[][] = []
      const client = {
        dmCandidates: async () => [person],
        createDm: async (ids: string[]) => {
          made.push(ids)
          return conversation
        }
      } as unknown as TeamStationClient
      const page = (
        access: 'pending' | 'allowed' | 'ask',
        shown: boolean
      ): React.ReactElement => (
        <ThemeProvider>
          <TestChatAge access={access}>
            <SceneShownProvider value={shown}>
              <PersonMessageButton
                client={client}
                userId={person.userId}
                onOpenChat={() => undefined}
              />
            </SceneShownProvider>
          </TestChatAge>
        </ThemeProvider>
      )
      await settle(() => {
        root!.render(page('pending', true))
      })
      await settle(() => {
        message()!.click()
      })
      // A frame pushed over the person page while the answer is pending.
      await settle(() => {
        root!.render(page('pending', false))
      })
      await settle(() => {
        root!.render(page(settled, false))
      })
      await settle(() => {
        root!.render(page(settled, true))
      })
      expect(made).deep.equals([])
      expect(sheet()).equals(null)
      expect(message()!.getAttribute('aria-disabled')).not.equals('true')
    })

  it('withdraws its sheet when the button goes', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const client = {
      dmCandidates: async () => [person]
    } as unknown as TeamStationClient
    const page = (shown: boolean): React.ReactElement => (
      <ThemeProvider>
        <TestChatAge access="ask">
          {shown && (
            <PersonMessageButton
              client={client}
              userId={person.userId}
              onOpenChat={() => undefined}
            />
          )}
        </TestChatAge>
      </ThemeProvider>
    )
    await settle(() => {
      root!.render(page(true))
    })
    await settle(() => {
      message()!.click()
    })
    expect(sheet()).not.equals(null)
    await settle(() => {
      root!.render(page(false))
    })
    expect(sheet()).equals(null)
  })
})
