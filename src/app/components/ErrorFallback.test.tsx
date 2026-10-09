import { ErrorBoundary } from '@sentry/react'
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { RenderErrorProbe } from '../sentry'
import { ThemeProvider } from '../theme/ThemeContext'
import { ErrorFallback, errorScreen } from './ErrorFallback'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

function press(container: HTMLElement, label: string): void {
  const target = Array.from(
    container.querySelectorAll<HTMLElement>('[role="button"], button')
  ).find(node => node.textContent === label)
  if (target == null) throw new Error(`no ${label} button`)
  target.click()
}

describe('ErrorFallback', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    // A modal draws outside its host, so the host may already be gone.
    if (host?.parentNode != null) host.parentNode.removeChild(host)
    host = undefined
  })

  it('says what happened and reloads on request', async function () {
    let reloads = 0
    const container = await render(
      <ErrorFallback
        onReload={() => {
          reloads++
        }}
      />
    )
    expect(container.textContent).contains('Something went wrong')
    expect(container.textContent).contains('It has been reported.')
    await act(async () => {
      press(container, 'Reload')
    })
    expect(reloads).equals(1)
  })

  it('replaces a screen that fails while drawing, and Reload draws it again', async function () {
    const realError = console.error
    console.error = () => undefined
    let broken = true
    function Screen(): React.ReactElement {
      return broken ? <RenderErrorProbe /> : <span>the app</span>
    }
    try {
      const container = await render(
        <ErrorBoundary fallback={errorScreen}>
          <Screen />
        </ErrorBoundary>
      )
      expect(container.textContent).contains('Something went wrong')
      broken = false
      await act(async () => {
        press(container, 'Reload')
      })
      expect(container.textContent).equals('the app')
    } finally {
      console.error = realError
    }
  })
})
