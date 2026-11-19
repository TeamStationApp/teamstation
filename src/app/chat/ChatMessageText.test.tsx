import { expect } from 'chai'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { openChatMessageLink } from './chatMessageLinks'
import { ChatMessageText } from './ChatMessageText'

describe('chat message links in a bubble', () => {
  const body =
    'Score sheet: example.com/game and http://example.org. Alternates: (example.net:8443),(example.org:8444). File: scores.pdf.'
  it('keeps the full caption selectable and activates just the chosen address', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const opened: string[] = []
    const show = async (active: boolean, held: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <ChatMessageText
            body={body}
            style={{}}
            selectable={active}
            onOpen={
              active
                ? address => {
                    opened.push(address)
                  }
                : undefined
            }
            gesture={{ pressProps: {}, canOpen: () => !held }}
          />
        )
      })
    }
    try {
      await show(true, false)
      expect(host.textContent).equals(body)
      const links = host.querySelectorAll('a')
      expect([...links].map(link => link.textContent)).deep.equals([
        'example.com/game',
        'http://example.org',
        'example.net:8443',
        'example.org:8444'
      ])
      expect(links[0].href).equals('https://example.com/game')
      expect(links[2].href).equals('https://example.net:8443/')
      expect(links[3].href).equals('https://example.org:8444/')
      expect(links[0].target).equals('_blank')
      expect(links[0].rel).contains('noopener')
      links[1].click()
      expect(opened).deep.equals(['http://example.org'])
      await show(true, true)
      host.querySelector('a')!.click()
      expect(opened).deep.equals(['http://example.org'])
      await show(false, false)
      expect(host.textContent).equals(body)
      expect(host.querySelector('a,[role="link"]')).equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})

describe('chat message links from the app', () => {
  it('opens browser links synchronously and delegates trusted links to navigation', async () => {
    const opened: unknown[][] = []
    const original = Object.getOwnPropertyDescriptor(window, 'open')
    window.open = (...args) => {
      opened.push(args)
      return null
    }
    try {
      const routes: string[] = []
      const navigate = (route: { name: string }): void => {
        routes.push(route.name)
      }
      const api = 'https://seat.example.test/api/v1'
      const opening = openChatMessageLink('example.org/a?x=1#t', api, navigate)
      expect(opened).deep.equals([
        ['https://example.org/a?x=1#t', '_blank', 'noopener,noreferrer']
      ])
      await opening
      await openChatMessageLink(
        'https://seat.example.test/schedule',
        api,
        navigate
      )
      await openChatMessageLink(
        'https://app.teamstation.app/chat',
        '/api/v1',
        navigate
      )
      await openChatMessageLink('file:///home', '/api/v1', navigate)
      expect(routes).deep.equals(['schedule', 'chat'])
      expect(opened).has.length(1)
    } finally {
      if (original == null) Reflect.deleteProperty(window, 'open')
      else Object.defineProperty(window, 'open', original)
    }
  })
})
