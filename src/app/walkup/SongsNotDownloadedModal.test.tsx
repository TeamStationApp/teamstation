import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Modal } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { SongsNotDownloadedModal } from './SongsNotDownloadedModal'

/**
 * The notice: its words, Ignore in red, and Go to Settings asking for the
 * walkthrough only once the notice has gone.
 *
 * Under react-native-web in jsdom the modal's `onShow` and `onDismiss` wait
 * for an animation end that never fires, so these tests call the `Modal`'s
 * own props, read off the rendered element.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Seen {
  closed: number
  settings: number
  shown: number
}

async function render(visible: boolean, seen: Seen): Promise<void> {
  const ui = (
    <ThemeProvider>
      <SongsNotDownloadedModal
        visible={visible}
        onClose={() => {
          seen.closed++
        }}
        onSettings={() => {
          seen.settings++
        }}
        onShow={() => {
          seen.shown++
        }}
      />
    </ThemeProvider>
  )
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(ui)
    await delay(20)
  })
}

function byText(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => (node.textContent ?? '') === label)
  expect(found, label).not.equals(undefined)
  return found!
}

/** The props React Native's `Modal` was rendered with. */
function rendered(): React.ComponentProps<typeof Modal> {
  const sheet = document.querySelector('[data-testid="songs-not-downloaded"]')
  expect(sheet).not.equals(null)
  const key = Object.keys(sheet!).find(name =>
    name.startsWith('__reactFiber$')
  )!
  let fiber = (sheet as unknown as Record<string, unknown>)[key] as {
    type: unknown
    memoizedProps: React.ComponentProps<typeof Modal>
    return: unknown
  } | null
  while (fiber != null && fiber.type !== Modal) {
    fiber = fiber.return as typeof fiber
  }
  expect(fiber, 'Modal').not.equals(null)
  return fiber!.memoizedProps
}

describe('SongsNotDownloadedModal', function () {
  // Inside the suite, so the modal's portal is unmounted before any
  // root-level hook clears the document.
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('says what is wrong, with Ignore in red', async function () {
    const seen: Seen = { closed: 0, settings: 0, shown: 0 }
    await render(true, seen)
    expect(document.body.textContent).includes(
      'Some walk-up songs still need to be downloaded. Make sure your Apple Music settings are configured properly.'
    )
    const ignore = byText('Ignore')
    const label = ignore.querySelector<HTMLElement>('div') ?? ignore
    const probe = document.createElement('div')
    probe.style.color = tsBallpark.dangerColor
    expect(getComputedStyle(label).color).equals(probe.style.color)
    const shown = rendered().onShow as (() => void) | undefined
    shown?.()
    expect(seen.shown).equals(1)
    await act(async () => {
      ignore.click()
      await delay(10)
    })
    expect(seen.closed).equals(1)
    rendered().onDismiss?.()
    expect(seen.settings).equals(0)
  })

  it('asks for the walkthrough only after Go to Settings has closed it', async function () {
    const seen: Seen = { closed: 0, settings: 0, shown: 0 }
    await render(true, seen)
    await act(async () => {
      byText('Go to Settings').click()
      await delay(10)
    })
    expect(seen.closed).equals(1)
    expect(seen.settings).equals(0)
    const props = rendered()
    await render(false, seen)
    props.onDismiss?.()
    expect(seen.settings).equals(1)
    props.onDismiss?.()
    expect(seen.settings).equals(1)
  })
})
