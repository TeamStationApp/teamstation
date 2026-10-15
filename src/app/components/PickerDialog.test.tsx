import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KeyboardAvoidingView, Platform, ScrollView, Text } from 'react-native'

import { getTheme, ThemeProvider } from '../theme/ThemeContext'
import { PickerDialog } from './PickerDialog'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

interface Fiber {
  type: unknown
  memoizedProps: Record<string, unknown> | null
  child: Fiber | null
  sibling: Fiber | null
  return: Fiber | null
}

/** Every component React drew under the root, by its props. */
function drawn(): Fiber[] {
  const node = document.querySelector('[data-testid="picked"]')!
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

/** The dialog, open until it is asked to close. */
function Opened(props: { maxWidthRem?: number }): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  if (!open) return <Text>Closed</Text>
  return (
    <PickerDialog
      maxWidthRem={props.maxWidthRem}
      onClose={() => {
        setOpen(false)
      }}
    >
      <Text testID="picked">A calendar</Text>
    </PickerDialog>
  )
}

/** The widest the dialog is drawn, from the style it was given. */
function widest(fibers: Fiber[]): number | undefined {
  const dialog = fibers.find(
    one => one.memoizedProps?.accessibilityViewIsModal === true
  )
  const style = Object.assign(
    {},
    ...(dialog?.memoizedProps?.style as object[])
  ) as { maxWidth?: number }
  return style.maxWidth
}

async function open(maxWidthRem?: number): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Opened maxWidthRem={maxWidthRem} />
      </ThemeProvider>
    )
    await new Promise(resolve => setTimeout(resolve, 15))
  })
}

async function close(fibers: Fiber[]): Promise<void> {
  const modal = fibers.find(
    one => typeof one.memoizedProps?.onRequestClose === 'function'
  )
  await act(async () => {
    ;(modal!.memoizedProps!.onRequestClose as () => void)()
    await new Promise(resolve => setTimeout(resolve, 15))
  })
}

describe('the picker dialog', function () {
  it('rises above the keyboard, and a tap while it is up reaches what it lands on', async function () {
    await open(24)
    expect(document.body.textContent).contains('A calendar')
    const fibers = drawn()
    expect(fibers.some(one => one.type === KeyboardAvoidingView)).equals(true)
    const scroll = fibers.find(one => one.type === ScrollView)
    expect(scroll?.memoizedProps?.keyboardShouldPersistTaps).equals('handled')
    // As wide as asked, at most.
    expect(widest(fibers)).equals(getTheme().rem(24))
    // Android's Back, or Escape on the web, asks it to close.
    await close(fibers)
    expect(document.body.textContent).contains('Closed')
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
        const fibers = drawn()
        const avoiding = fibers.find(one => one.type === KeyboardAvoidingView)
        expect(avoiding?.memoizedProps?.behavior, os).equals(behavior)
        await close(fibers)
        await act(async () => {
          root?.unmount()
        })
        root = undefined
        document.body.innerHTML = ''
      }
    } finally {
      platform.OS = previous
    }
  })

  it('is 28 rem wide at most unless asked otherwise', async function () {
    await open()
    const fibers = drawn()
    expect(widest(fibers)).equals(getTheme().rem(28))
    await close(fibers)
  })
})
