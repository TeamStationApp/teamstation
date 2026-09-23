import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { CORRECTION_INSTRUCTION, InstructionToast } from './InstructionToast'
import { runnerDragView } from './runnerDrag'
import { RunnerDragTargets } from './RunnerDragTargets'
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
describe('runner drag targets', function () {
  it('exposes keyboard decisions as focusable buttons and disables an illegal Safe choice', async function () {
    const view = {
      ...runnerDragView(
        'r',
        1,
        { x: 0, z: -40 },
        () => ({ x: 200, y: 300 }),
        390,
        700
      ),
      keyboard: true
    }
    const choices: string[] = []
    let cancelled = false
    await render(
      <RunnerDragTargets
        view={view}
        onChoose={choice => {
          choices.push(choice)
        }}
        onCancel={() => {
          cancelled = true
        }}
      />
    )
    const safe = host.querySelector<HTMLElement>(
      '[aria-label="Safe drag target"]'
    )!
    expect(safe.getAttribute('role')).equals('button')
    expect(safe.tabIndex).equals(0)
    await act(async () => {
      safe.focus()
      safe.click()
    })
    expect(choices).deep.equals(['safe'])
    await act(async () => {
      safe.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(cancelled).equals(true)
    await render(
      <RunnerDragTargets
        view={{ ...view, safeDisabled: 'Occupied' }}
        onChoose={choice => {
          choices.push(choice)
        }}
      />
    )
    expect(safe.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      safe.click()
    })
    expect(choices).deep.equals(['safe'])
  })
  it('shows only two plain targets with idle and hover colors', async function () {
    const view = runnerDragView(
      'r',
      1,
      { x: 0, z: -40 },
      () => ({ x: 200, y: 300 }),
      390,
      700
    )
    for (const hovered of [undefined, 'safe', 'out'] as const) {
      await render(<RunnerDragTargets view={{ ...view, hovered }} />)
      expect(host.textContent).equals('SafeOut')
      const safe = host.querySelector<HTMLElement>(
        '[aria-label="Safe drag target"]'
      )!
      expect(safe.style.backgroundColor).equals(
        hovered === 'safe' ? 'rgb(36, 113, 61)' : 'rgb(169, 215, 181)'
      )
      expect((host.firstChild as HTMLElement).style.backgroundColor).equals('')
    }
    await render(<RunnerDragTargets view={null} />)
    expect(host.textContent).equals('')
  })
})
describe('scoring instruction and completion toast', function () {
  it('separates trajectory detail and defensive completion from the countdown', async function () {
    let finished = 0
    await render(
      <InstructionToast
        instruction="Drag up and down for ball trajectory."
        detail="45° Fly Ball"
      />
    )
    expect(host.textContent).includes('45° Fly Ball')
    expect(host.querySelector('[role="progressbar"]')).equals(null)
    await render(
      <InstructionToast
        instruction="Drag the next defender"
        finishLabel="Finish defensive play"
        canFinish
        onFinish={() => {
          finished++
        }}
      />
    )
    const done = host.querySelector<HTMLElement>(
      '[aria-label="Finish defensive play"]'
    )!
    expect(done.style.backgroundColor).equals('rgb(36, 113, 61)')
    expect(host.querySelector('[aria-label="Finish at-bat"]')).equals(null)
    await act(async () => {
      done.click()
    })
    expect(finished).equals(1)
  })
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
