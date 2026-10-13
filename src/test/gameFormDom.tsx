import { expect } from 'chai'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../app/theme/ThemeContext'
import { chooseSchedule } from './eventScheduleDom'

/** The DOM steps the game form and team selector suites share. */
let root: Root | undefined

export async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  await settle()
}

export async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
}

export async function settle(milliseconds = 280): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  })
}

export function buttons(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="radio"], [role="switch"]'
    )
  ]
}

/** By its label, or a row whose label is this title and then its subtitle. */
export function find(label: string): HTMLElement | undefined {
  const named = (node: HTMLElement): string =>
    node.getAttribute('aria-label') ?? node.textContent ?? ''
  return (
    buttons().find(node => named(node) === label) ??
    buttons().find(node => named(node).startsWith(label + ', '))
  )
}

export async function press(label: string): Promise<void> {
  const button = find(label)
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
  })
  await settle(0)
}

export async function fill(label: string, value: string): Promise<void> {
  if (
    [
      'Date',
      'End date',
      'Time',
      'Start time',
      'End time',
      'Time zone'
    ].includes(label)
  ) {
    await chooseSchedule(label, value)
    return
  }
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input!.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

export function text(): string {
  return document.body.textContent ?? ''
}
