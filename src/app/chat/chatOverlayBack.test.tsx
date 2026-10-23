import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { HeaderSlotProvider } from '../components/headerSlot'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { ChatOverlayHost } from './ChatOverlayHost'
import { ChatListNavigationCapture } from './chatWorkspaceModel'
import { MessageActionOverlay } from './MessageActionOverlay'

/**
 * A chat overlay holds Back while it is open. Its own `hardwareBackPress`
 * listener closes it, but Android's back gesture, enabled over a conversation
 * pushed on the chat list, answers Back before React Native does: the shell
 * turns that off while a screen holds Back, so the overlay closes and the
 * conversation stays.
 */
describe('chat overlays and Back', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
  })

  async function render(
    overlay: React.ReactNode,
    held: Array<(() => void) | null>
  ): Promise<void> {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider
            headerHeight={48}
            onHandoff={() => undefined}
            onBackOverride={handler => {
              held.push(handler)
            }}
          >
            <ChatOverlayHost>{overlay}</ChatOverlayHost>
          </HeaderSlotProvider>
        </ThemeProvider>
      )
    })
  }

  it('holds Back while a conversation menu is open, and closes on it', async function () {
    const held: Array<(() => void) | null> = []
    let closes = 0
    await render(
      <ChatActionOverlay
        label="Conversation"
        onClose={() => {
          closes++
        }}
      >
        <Text>Menu</Text>
      </ChatActionOverlay>,
      held
    )
    const back = held.at(-1)
    expect(back).not.equals(null)
    expect(back).not.equals(undefined)
    await act(async () => {
      back!()
    })
    expect(closes).equals(1)
    await act(async () => {
      root!.render(<ThemeProvider>{null}</ThemeProvider>)
    })
    expect(held.at(-1)).equals(null)
  })

  it('holds Back while a message menu is open, and closes on it once', async function () {
    const held: Array<(() => void) | null> = []
    let closes = 0
    const menu = (closing: boolean): React.ReactElement => (
      <MessageActionOverlay
        label="Message"
        selected={<Text>Hello</Text>}
        mine={false}
        closing={closing}
        onClose={() => {
          closes++
        }}
        onClosed={() => undefined}
      >
        <Text>Reply</Text>
      </MessageActionOverlay>
    )
    await render(menu(false), held)
    const back = held.at(-1)
    expect(back).not.equals(null)
    await act(async () => {
      back!()
    })
    expect(closes).equals(1)
    // Already closing: a second Back adds nothing.
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider
            headerHeight={48}
            onHandoff={() => undefined}
            onBackOverride={handler => {
              held.push(handler)
            }}
          >
            <ChatOverlayHost>{menu(true)}</ChatOverlayHost>
          </HeaderSlotProvider>
        </ThemeProvider>
      )
    })
    held.at(-1)?.()
    expect(closes).equals(1)
  })

  it('hands Back to the overlay still open when another, opened under it, goes', async function () {
    const held: Array<(() => void) | null> = []
    const closes: string[] = []
    // One setter for the slot, as a scene's is.
    const hold = (handler: (() => void) | null): void => {
      held.push(handler)
    }
    const handOff = (): void => undefined
    const overlays = (menu: boolean): React.ReactElement => (
      <ThemeProvider>
        <HeaderSlotProvider
          headerHeight={48}
          onHandoff={handOff}
          onBackOverride={hold}
        >
          <ChatOverlayHost>
            {menu && (
              <MessageActionOverlay
                label="Message"
                selected={<Text>Hello</Text>}
                mine={false}
                closing
                onClose={() => {
                  closes.push('menu')
                }}
                onClosed={() => undefined}
              >
                <Text>Reply</Text>
              </MessageActionOverlay>
            )}
            <ChatActionOverlay
              label="Mention"
              onClose={() => {
                closes.push('picker')
              }}
            >
              <Text>Picker</Text>
            </ChatActionOverlay>
          </ChatOverlayHost>
        </HeaderSlotProvider>
      </ThemeProvider>
    )
    // The menu, still closing after Reply, and the mention picker opened
    // over it by typing "@".
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(overlays(true))
    })
    // The menu finishes closing: Back is the picker's, not nobody's.
    await act(async () => {
      root!.render(overlays(false))
    })
    const back = held.at(-1)
    expect(back).not.equals(null)
    await act(async () => {
      back!()
    })
    expect(closes).deep.equals(['picker'])
  })

  it('gives the list reader back to the conversation when the list a drag revealed leaves', async function () {
    const navigation = new ChatListNavigationCapture()
    const reads: string[] = []
    // The conversation's list, then the chat root's, drawn beneath a drag.
    const conversation = navigation.attach(async () => {
      reads.push('conversation')
      return 'accepted'
    })
    const beneath = navigation.attach(async () => {
      reads.push('beneath')
      return 'accepted'
    })
    // The drag is cancelled: the root's list unmounts.
    beneath()
    expect(navigation.hasReader()).equals(true)
    expect(await navigation.capture()).equals('accepted')
    expect(reads).deep.equals(['conversation'])
    conversation()
    expect(navigation.hasReader()).equals(false)
  })

  it('pops once for two Backs pressed while the list’s position is still being kept', async function () {
    const navigation = new ChatListNavigationCapture()
    const reads: Array<() => void> = []
    navigation.attach(async () => {
      await new Promise<void>(resolve => reads.push(resolve))
      return 'accepted'
    })
    const release = async (): Promise<void> => {
      while (reads.length === 0)
        await new Promise(resolve => setTimeout(resolve, 0))
      reads.shift()!()
    }
    const pops: string[] = []
    const first = navigation.navigateOnce('pop', () => pops.push('first'))
    await navigation.navigateOnce('pop', () => pops.push('second'))
    expect(pops).deep.equals([])
    await release()
    await first
    expect(pops).deep.equals(['first'])
    // Kept: the next Back pops again.
    const third = navigation.navigateOnce('pop', () => pops.push('third'))
    await release()
    await third
    expect(pops).deep.equals(['first', 'third'])
  })
})
