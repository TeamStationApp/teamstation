import { expect } from 'chai'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  NavCompactProvider,
  useNavCompact,
  useNavCompactScroll,
  useNavScroll,
  useNavScrollInput
} from './navCompact'
import { SceneShownProvider } from './sceneShown'

describe('the phone navigation scroll state', () => {
  it('resets after a tab press and ignores a docked screen until it leaves', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let scroll!: ReturnType<typeof useNavCompactScroll>
    let input!: ReturnType<typeof useNavScrollInput>
    let controls!: ReturnType<typeof useNavScroll>
    function Screen(): React.ReactElement {
      scroll = useNavCompactScroll()
      input = useNavScrollInput(scroll)
      controls = useNavScroll()
      return <span>{useNavCompact() ? 'compact' : 'expanded'}</span>
    }
    const down = (): void => {
      scroll?.(0, 800, 250)
      scroll?.(130, 800, 250)
    }
    try {
      await act(async () => {
        root.render(
          <NavCompactProvider>
            <Screen />
          </NavCompactProvider>
        )
      })
      await act(async () => {
        // Horizontal wheel and text editing do not seed a later restored offset.
        input.onWheel?.({ currentTarget: { scrollTop: 0 }, deltaY: 0 })
        input.onKeyDown?.({ currentTarget: { scrollTop: 0 }, key: 'a' })
        input.onKeyDown?.({
          currentTarget: { scrollTop: 0 },
          key: 'End',
          target: document.createElement('input')
        })
        input.onPointerDown?.({
          currentTarget: { scrollTop: 0 },
          pointerType: 'mouse',
          target: document.createElement('button')
        })
        scroll?.(400, 800, 250)
      })
      expect(host.textContent).equals('expanded')
      await act(async () => {
        down()
      })
      expect(host.textContent).equals('compact')
      await act(async () => {
        controls.reset()
      })
      expect(host.textContent).equals('expanded')
      await act(async () => {
        // The first scroll callback after reset can follow several browser wheel inputs.
        for (const y of [0, 20, 40, 60, 80, 100]) scroll?.(y, 0, 0, true)
        scroll?.(120, 800, 250)
      })
      expect(host.textContent).equals('compact')
      await act(async () => {
        controls.setEnabled(false)
        down()
      })
      expect(host.textContent).equals('expanded')
      await act(async () => {
        expect(scroll).equals(undefined)
        expect(input.onWheel).equals(undefined)
        expect(input.onPointerDown).equals(undefined)
        expect(input.onKeyDown).equals(undefined)
        controls.setEnabled(true)
      })
      await act(async () => {
        down()
      })
      expect(host.textContent).equals('compact')
      await act(async () => {
        scroll?.(100, 800, 250)
      })
      expect(host.textContent).equals('expanded')
      await act(async () => {
        root.render(
          <NavCompactProvider>
            <SceneShownProvider value={false}>
              <Screen />
            </SceneShownProvider>
          </NavCompactProvider>
        )
      })
      await act(async () => {
        down()
      })
      expect(
        host.textContent,
        'a covered scene can coast without hiding navigation'
      ).equals('expanded')
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })
})
