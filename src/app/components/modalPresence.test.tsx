import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { View } from 'react-native'

import { Modal } from './Modal'
import {
  createModalPresence,
  ModalPresenceProvider,
  useModalsOpen,
  useScreenClaimed
} from './modalPresence'

let root: Root | undefined

const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('the count of modals on show', function () {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
  })

  it('re-renders the screen that opens a modal and what reads the count, never the shell', async function () {
    const presence = createModalPresence(30)
    const renders = { shell: 0, sibling: 0, reader: 0, claimReader: 0 }
    const read: number[] = []
    let open!: (shown: boolean) => void
    function Screen(): React.ReactElement {
      const [shown, setShown] = useState(false)
      open = setShown
      return (
        <>
          {shown && (
            <Modal transparent visible>
              <View />
            </Modal>
          )}
        </>
      )
    }
    function Sibling(): React.ReactElement {
      renders.sibling++
      return <View />
    }
    function Reader(): React.ReactElement {
      renders.reader++
      read.push(useModalsOpen())
      return <View />
    }
    function ClaimReader(): React.ReactElement {
      renders.claimReader++
      useScreenClaimed()
      return <View />
    }
    function Shell(): React.ReactElement {
      renders.shell++
      return (
        <ModalPresenceProvider presence={presence}>
          <Screen />
          <Sibling />
          <Reader />
          <ClaimReader />
        </ModalPresenceProvider>
      )
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Shell />)
    })
    const before = { ...renders }
    await act(async () => {
      open(true)
    })
    expect(presence.open()).equals(1)
    expect(read.at(-1), 'the reader sees it').equals(1)
    expect(renders.shell, 'the shell').equals(before.shell)
    expect(renders.sibling, 'a screen beside it').equals(before.sibling)
    expect(renders.claimReader, 'nothing claimed').equals(before.claimReader)
    await act(async () => {
      open(false)
    })
    expect(presence.open(), 'gone, still dismissing').equals(1)
    await wait(60)
    expect(presence.open()).equals(0)
    expect(read.at(-1)).equals(0)
    expect(renders.shell).equals(before.shell)
    expect(renders.sibling).equals(before.sibling)
  })

  it('holds the others while one claims the screen, until it has finished going', async function () {
    const presence = createModalPresence(30)
    let set!: (next: { claim: boolean; other: boolean }) => void
    function Screens(): React.ReactElement {
      const [shown, setShown] = useState({ claim: true, other: false })
      set = setShown
      return (
        <>
          {shown.claim && (
            <Modal transparent visible claims testID="claiming">
              <View />
            </Modal>
          )}
          {shown.other && (
            <Modal transparent visible>
              <View testID="other" />
            </Modal>
          )}
        </>
      )
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ModalPresenceProvider presence={presence}>
          <Screens />
        </ModalPresenceProvider>
      )
    })
    const other = (): Element | null =>
      document.querySelector('[data-testid="other"]')
    await act(async () => {
      set({ claim: true, other: true })
    })
    expect(presence.claimed()).equals(true)
    expect(other(), 'waits for the claim').equals(null)
    expect(presence.open(), 'not counted meanwhile').equals(0)
    await act(async () => {
      set({ claim: false, other: true })
    })
    expect(presence.claimed(), 'still going').equals(true)
    expect(other()).equals(null)
    await wait(60)
    expect(presence.claimed()).equals(false)
    expect(other()).not.equals(null)
    expect(presence.open()).equals(1)
  })

  it('counts nothing outside the shell', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const read: number[] = []
    function Reader(): React.ReactElement {
      read.push(useModalsOpen())
      return (
        <Modal transparent visible>
          <View testID="alone" />
        </Modal>
      )
    }
    await act(async () => {
      root!.render(<Reader />)
    })
    expect(document.querySelector('[data-testid="alone"]')).not.equals(null)
    expect(read.at(-1)).equals(0)
  })
})
