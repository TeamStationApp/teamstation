import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KeyboardAvoidingView, Modal, Platform, ScrollView } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { AngleNamePrompt, KEYBOARD_RETRY_MS } from './AngleNamePrompt'

let root: Root | undefined

interface Fiber {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  child: Fiber | null
  sibling: Fiber | null
  return: Fiber | null
}

/** Every component React drew under the root, by its props. */
function drawn(): Fiber[] {
  const node = document.querySelector('[data-testid="angle-name-prompt"]')!
  const key = Object.keys(node).find(one => one.startsWith('__reactFiber'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as Fiber
  while (fiber.return != null) fiber = fiber.return
  const all: Fiber[] = []
  const visit = (one: Fiber | null): void => {
    for (let child = one; child != null; child = child.sibling) {
      all.push(child)
      visit(child.child)
    }
  }
  visit(fiber)
  return all
}

async function open(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <AngleNamePrompt visible onCancel={() => {}} onStart={async () => {}} />
      </ThemeProvider>
    )
    await new Promise(resolve => setTimeout(resolve, 15))
  })
}

async function shut(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
}

describe('the angle name prompt', function () {
  afterEach(async function () {
    await shut()
  })

  it('rises above the keyboard with Cancel and Start inside what rises, and a tap while the keyboard is up reaches them', async function () {
    await open()
    const fibers = drawn()
    const avoiding = fibers.find(one => one.type === KeyboardAvoidingView)
    expect(avoiding, 'a keyboard-avoiding view').not.equals(undefined)
    const scroll = fibers.find(
      one =>
        one.type === ScrollView &&
        one.memoizedProps?.testID === 'angle-name-prompt'
    )
    expect(scroll?.memoizedProps?.keyboardShouldPersistTaps).equals('handled')
    // The sheet, and so both buttons, are drawn inside the avoiding view.
    let up: Fiber | null = scroll ?? null
    while (up != null && up !== avoiding) up = up.return
    expect(up, 'the sheet sits inside the avoiding view').equals(avoiding)
    const sheet = document.querySelector('[data-testid="angle-name-prompt"]')!
    const labels = Array.from(sheet.querySelectorAll('[role="button"]')).map(
      one => one.textContent
    )
    expect(labels).to.include.members(['Cancel', 'Start'])
  })

  it('raises the keyboard once the modal is on screen on Android, and with autoFocus elsewhere', async function () {
    const platform = Platform as { OS: string }
    const previous = platform.OS
    try {
      platform.OS = 'android'
      await open()
      const input = document.querySelector('input')!
      // Not before the dialog's window is up: focused then, Android shows a
      // cursor and no keyboard.
      expect(document.activeElement, 'not focused before it shows').not.equals(
        input
      )
      const modal = drawn().find(one => one.type === Modal)
      const onShow = modal?.memoizedProps?.onShow as (() => void) | undefined
      expect(onShow, 'the modal says when it is shown').not.equals(undefined)
      await act(async () => {
        onShow?.()
      })
      expect(document.activeElement, 'focused once shown').equals(input)
      // No keyboard came up: it is focused afresh a moment later.
      input.blur()
      await act(async () => {
        await new Promise(resolve =>
          setTimeout(resolve, KEYBOARD_RETRY_MS + 50)
        )
      })
      expect(document.activeElement, 'focused again').equals(input)
      await shut()

      platform.OS = 'ios'
      await open()
      expect(document.activeElement, 'iOS focuses it at once').equals(
        document.querySelector('input')
      )
    } finally {
      platform.OS = previous
    }
  })

  it('pads above the keyboard on iOS and shrinks to it on Android, whose modal window stays full height', async function () {
    const platform = Platform as { OS: string }
    const previous = platform.OS
    try {
      for (const [os, behavior] of [
        ['ios', 'padding'],
        ['android', 'height'],
        ['web', undefined]
      ] as const) {
        platform.OS = os
        await open()
        const avoiding = drawn().find(one => one.type === KeyboardAvoidingView)
        expect(avoiding?.memoizedProps?.behavior, os).equals(behavior)
        await shut()
      }
    } finally {
      platform.OS = previous
    }
  })
})
