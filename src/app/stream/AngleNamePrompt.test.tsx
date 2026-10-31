import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KeyboardAvoidingView, Modal, Platform, ScrollView } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import {
  AngleNamePrompt,
  type AngleNamePromptProps,
  angleSuggestions,
  KEYBOARD_RETRY_MS
} from './AngleNamePrompt'
import { SHEET_HEIGHT } from './SheetModal'

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

async function open(props: Partial<AngleNamePromptProps> = {}): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <AngleNamePrompt
          visible
          onCancel={() => {}}
          onStart={async () => {}}
          {...props}
        />
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

  it('rises above the keyboard with its rows inside what rises, and a tap while the keyboard is up reaches them', async function () {
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
    // The sheet, and so both rows, are drawn inside the avoiding view.
    let up: Fiber | null = scroll ?? null
    while (up != null && up !== avoiding) up = up.return
    expect(up, 'the sheet sits inside the avoiding view').equals(avoiding)
    const sheet = document.querySelector('[data-testid="angle-name-prompt"]')!
    const labels = Array.from(sheet.querySelectorAll('[role="button"]')).map(
      one => one.getAttribute('aria-label') ?? one.textContent
    )
    expect(labels).to.include.members([
      'Cancel',
      'Record with this phone',
      'Use external camera'
    ])
  })

  it('takes three quarters of the screen, and slides up', async function () {
    const page = document.documentElement
    const windowOf = (height: number): void => {
      Object.defineProperty(page, 'clientHeight', {
        configurable: true,
        value: height
      })
      window.dispatchEvent(new window.Event('resize'))
    }
    try {
      windowOf(1000)
      await open()
      const fibers = drawn()
      expect(
        fibers.find(one => one.type === Modal)?.memoizedProps?.animationType
      ).equals('slide')
      const sized = fibers.flatMap(one => {
        const style = one.memoizedProps?.style
        return Array.isArray(style)
          ? style.filter(part => part?.height === 1000 * SHEET_HEIGHT)
          : []
      })
      expect(sized, 'a sheet that tall').not.deep.equals([])
    } finally {
      windowOf(0)
    }
  })

  it('leaves out each row that does not apply', async function () {
    const rows = (): string =>
      document.querySelector('[data-testid="angle-name-prompt"]')!
        .textContent ?? ''
    await open({ phoneOnly: true })
    expect(rows()).contains('Record with this phone')
    expect(rows()).not.contains('Use external camera')
    await shut()
    await open({ canRecord: false })
    expect(rows()).not.contains('Record with this phone')
    expect(rows()).contains('Use external camera')
  })

  it('offers Backstop where the field shows it can be typed', async function () {
    await open()
    expect(document.querySelector('input')?.placeholder).equals(
      'i.e., Home, 1st, 3rd, Backstop'
    )
    expect(angleSuggestions()).deep.equals(['Home', '1st', '3rd', 'Backstop'])
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
