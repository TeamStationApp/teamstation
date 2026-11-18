import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, TextInput } from 'react-native'

import { useKeyboardControllerOwner } from '../components/keyboardControllerOwner'
import { dismissKeyboard, KeyboardSpacer, SearchDock } from './SearchDock'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}

function Owner(): React.ReactElement {
  useKeyboardControllerOwner(true)
  return <Text>owned</Text>
}

describe('the Search dock with no keyboard to ride', function () {
  it('floats its pills above its field `bottom` up from the foot, and reports its size', async function () {
    const layouts: unknown[] = []
    await mount(
      <SearchDock
        bottom={96}
        gap={12}
        active
        style={{ position: 'absolute' }}
        onLayout={event => layouts.push(event)}
      >
        <Text>pills</Text>
        <Text>field</Text>
      </SearchDock>
    )
    const dock = document.querySelector<HTMLElement>(
      '[data-testid="search-dock"]'
    )!
    expect(dock.textContent).equals('pillsfield')
    expect(getComputedStyle(dock).bottom).equals('96px')
    expect(getComputedStyle(dock).position).equals('absolute')
  })

  it('makes no room for a keyboard, puts any away, and holds no keyboard controller', async function () {
    await mount(
      <>
        <KeyboardSpacer />
        <Owner />
        <TextInput accessibilityLabel="Typed" />
      </>
    )
    expect(document.body.textContent).equals('owned')
    const input = document.querySelector<HTMLElement>('[aria-label="Typed"]')!
    await act(async () => {
      input.focus()
    })
    expect(document.activeElement).equals(input)
    await act(async () => {
      dismissKeyboard()
    })
    expect(document.activeElement).not.equals(input)
  })
})
