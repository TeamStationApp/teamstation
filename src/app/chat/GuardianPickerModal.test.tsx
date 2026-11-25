import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DmProxies, TeamStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { GuardianPickerModal } from './GuardianPickerModal'

let root: Root | undefined
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action()
    await delay()
  })
}
const words = (): string => document.body.textContent ?? ''
const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const answer = (
  kind: DmProxies['kind'],
  why: DmProxies['why'] = 'noAccount'
): DmProxies => ({
  player: { userId: 'usr_player', shortName: 'Riley Rookie' },
  kind,
  why,
  people: [
    {
      userId: 'usr_nora',
      shortName: 'Nora Nash',
      avatarUrl: null,
      affiliations: 'Guardian of Riley Rookie · Hawks'
    },
    {
      userId: 'usr_gale',
      shortName: 'Gale Guardian',
      avatarUrl: null,
      affiliations: ''
    }
  ]
})
async function render(
  dmProxies: TeamStationClient['dmProxies'],
  events: { chose: string[]; closed: number }
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await settle(() => {
    root!.render(
      <ThemeProvider>
        <GuardianPickerModal
          client={{ dmProxies }}
          userId="usr_player"
          name="Riley R"
          onChoose={userId => {
            events.chose.push(userId)
          }}
          onClose={() => {
            events.closed++
          }}
        />
      </ThemeProvider>
    )
  })
}
afterEach(async function () {
  await settle(() => root?.unmount())
  root = undefined
})

describe('the picker of whom to message for a player who cannot sign in', function () {
  it('says the player has no account and lists their guardians to choose from', async function () {
    const asked: string[] = []
    const events = { chose: [] as string[], closed: 0 }
    await render(async userId => {
      asked.push(userId)
      return answer('guardians')
    }, events)
    expect(asked).deep.equals(['usr_player'])
    expect(words()).contains("Riley Rookie doesn't have an account")
    expect(words()).contains('Choose a guardian to message')
    expect(words()).contains('Guardian of Riley Rookie · Hawks')
    expect(byId('dm-proxy-usr_nora')?.getAttribute('aria-label')).equals(
      'Message Nora Nash'
    )
    await settle(() => {
      byId('dm-proxy-usr_gale')!.click()
    })
    expect(events.chose).deep.equals(['usr_gale'])
    expect(events.closed).equals(0)
  })

  it('says a player under 13 with an account cannot use chat yet', async function () {
    await render(async () => answer('guardians', 'tooYoung'), {
      chose: [],
      closed: 0
    })
    expect(words()).contains("Riley Rookie can't use chat yet")
    expect(words()).not.contains('account')
  })

  it('asks for a coach when the player has no guardian to message', async function () {
    await render(async () => answer('coaches'), { chose: [], closed: 0 })
    expect(words()).contains('Choose a coach to message')
    expect(words()).not.contains('Choose a guardian')
  })

  it('names the player from the caller until the answer comes, then closes on Cancel', async function () {
    let finish!: (value: DmProxies) => void
    const events = { chose: [] as string[], closed: 0 }
    await render(
      async () =>
        await new Promise<DmProxies>(resolve => {
          finish = resolve
        }),
      events
    )
    // Only the name until the server says why.
    expect(words()).contains('Riley R')
    expect(words()).not.contains('account')
    expect(words()).contains('Loading')
    await settle(() => {
      byId('dm-proxy-cancel')!.click()
    })
    expect(events.closed).equals(1)
    expect(events.chose).deep.equals([])
    await settle(() => {
      finish(answer('guardians'))
    })
  })

  it('says when the list cannot be read, still offering Cancel', async function () {
    const events = { chose: [] as string[], closed: 0 }
    await render(async () => {
      throw new Error('offline')
    }, events)
    expect(document.querySelector('[role="alert"]')?.textContent).equals(
      'The conversation could not be started.'
    )
    await settle(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Cancel"][role="button"]')!
        .click()
    })
    expect(events.closed).equals(1)
  })

  it('keeps to the name alone when the read fails, saying nothing of why', async function () {
    await render(
      async () => {
        throw new Error('offline')
      },
      { chose: [], closed: 0 }
    )
    expect(words()).contains('Riley R')
    expect(words()).not.contains('account')
    expect(words()).not.contains('chat yet')
  })

  it('falls back on the caller’s name when the server names the player with nothing', async function () {
    await render(
      async () => ({
        ...answer('guardians'),
        player: { userId: 'usr_player', shortName: '' }
      }),
      { chose: [], closed: 0 }
    )
    expect(words()).contains("Riley R doesn't have an account")
  })

  it('ignores an answer that comes after it has gone', async function () {
    let finish!: (value: DmProxies) => void
    await render(
      async () =>
        await new Promise<DmProxies>(resolve => {
          finish = resolve
        }),
      { chose: [], closed: 0 }
    )
    await settle(() => root?.unmount())
    root = undefined
    await settle(() => {
      finish(answer('guardians'))
    })
    expect(words()).not.contains('Nora Nash')
  })
})
