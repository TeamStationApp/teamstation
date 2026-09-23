import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { CORRECTION_INSTRUCTION, InstructionToast } from './InstructionToast'
let root: Root | undefined
let host: HTMLDivElement
async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(gsBallpark)
  })
  root = undefined
  host?.remove()
})
describe('scoring instruction and completion toast', function () {
  it('uses one clock for the numeric countdown and left-anchored shrinking line', async function () {
    let finished = 0
    const view = (ms: number, enabled = true): React.ReactElement => (
      <InstructionToast
        remainingMs={ms}
        canFinish={enabled}
        onFinish={() => {
          finished++
        }}
      />
    )
    await render(view(10000))
    expect(host.textContent).includes(CORRECTION_INSTRUCTION)
    const progress = (): HTMLElement =>
      host.querySelector('[role="progressbar"]')!
    expect(progress().getAttribute('aria-valuenow')).equals('10')
    expect((progress().firstChild as HTMLElement).style.width).equals('100%')
    await render(view(4201, false))
    expect(progress().getAttribute('aria-valuenow')).equals('5')
    expect((progress().firstChild as HTMLElement).style.width).equals('42.01%')
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Finish at-bat"]')!.click()
    })
    expect(finished).equals(0)
    await render(view(4201))
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Finish at-bat"]')!.click()
    })
    expect(finished).equals(1)
    await render(<InstructionToast />)
    expect(host.textContent).equals('')
  })
  it('renders phase guidance with theme colors, projected bounds and no countdown', async function () {
    for (const theme of [gsBallpark, gsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      await render(
        <InstructionToast
          instruction="Drag the fielder"
          bounds={{ x: 20, y: 100, width: 340, height: 90 }}
        />
      )
      expect(host.textContent).equals('Drag the fielder')
      expect(host.querySelector('[role="progressbar"]')).equals(null)
      const panel = host.firstChild as HTMLElement
      expect(panel.style.left).equals('20px')
      expect(panel.style.top).equals('100px')
      expect(panel.style.width).equals('340px')
      expect(panel.style.backgroundColor).equals('rgb(102, 80, 22)')
    }
  })
})
