import { expect } from 'chai'
import { afterEach, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { Checkbox } from './Checkbox'
import { PillButton } from './PillTabs'
import { TextWidthButton } from './TextWidthButton'
let root: Root | undefined
async function mount(node: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{node}</ThemeProvider>)
  })
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
it('draws the small hero-sized pill inside the same accessible target', async () => {
  await mount(
    <TextWidthButton small label="Conflict" onPress={() => undefined} />
  )
  const target = document.querySelector<HTMLElement>('[aria-label="Conflict"]')!
  const shell = getComputedStyle(target.firstElementChild!)
  expect(getComputedStyle(target).minHeight).equals('48px')
  expect(shell.minHeight).equals('24px')
  expect(shell.paddingLeft).equals('12px')
  expect(shell.paddingTop).equals('2px')
})
it('matches compact tab geometry without stretching the action and keeps a large target', async () => {
  let presses = 0
  await mount(
    <>
      <PillButton label="Tab" />
      <TextWidthButton
        label="Sign Up"
        onPress={() => {
          presses++
        }}
      />
    </>
  )
  const button = document.querySelector<HTMLElement>('[aria-label="Sign Up"]')!
  const pill = button.firstElementChild!
  const tab = document.querySelector('[data-testid="settings-pill-tab"]')!
  expect(getComputedStyle(pill).minHeight).equals(getComputedStyle(tab).height)
  expect(getComputedStyle(pill).paddingLeft).equals(
    getComputedStyle(tab).paddingLeft
  )
  expect(getComputedStyle(button).alignSelf).equals('flex-start')
  expect(getComputedStyle(button).minHeight).equals('48px')
  expect(getComputedStyle(button).maxWidth).equals('100%')
  await act(async () => {
    button.click()
  })
  expect(presses).equals(1)
})
it('keeps long action text, custom colors and busy/disabled actions inert', async () => {
  let presses = 0
  await mount(
    <>
      <TextWidthButton
        label="Apply umpire requirements to the below seasons"
        color="#EEEEEE"
        textColor="#616161"
        busy
        onPress={() => {
          presses++
        }}
      />
      <TextWidthButton
        label="Disabled"
        disabled
        onPress={() => {
          presses++
        }}
      />
    </>
  )
  const buttons = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
  for (const b of buttons) {
    await act(async () => {
      b.click()
    })
    expect(b.getAttribute('aria-disabled')).equals('true')
  }
  expect(presses).equals(0)
  expect(buttons[0].getAttribute('aria-busy')).equals('true')
  expect(buttons[0].textContent).contains(
    'Apply umpire requirements to the below seasons'
  )
  expect(
    getComputedStyle(buttons[0].firstElementChild!).backgroundColor
  ).equals('rgb(238, 238, 238)')
})
it('keeps checkbox selection accessible without a visible label and ignores disabled Space', async () => {
  let presses = 0
  await mount(
    <Checkbox
      label="Select Demo"
      hideLabel
      checked
      disabled
      onPress={() => {
        presses++
      }}
    />
  )
  const box = document.querySelector<HTMLElement>('[role="checkbox"]')!
  expect(box.textContent).equals('✓')
  expect(
    getComputedStyle(box.querySelector('[data-testid="checkbox-square"]')!)
      .width
  ).equals('24px')
  await act(async () =>
    box.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: ' ', bubbles: true })
    )
  )
  expect(presses).equals(0)
})
