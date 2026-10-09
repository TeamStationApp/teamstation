import { ErrorBoundary } from '@sentry/react'
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { BuildInfoModal, sendTestError } from './BuildInfoModal'
import { errorScreen } from './ErrorFallback'

let root: Root | undefined
let host: HTMLElement | undefined

const info = {
  app: 'TeamStation',
  version: '1.0',
  buildNumber: '1.0.42',
  branch: 'master',
  commit: 'abc1234',
  builtAt: '2026-10-08'
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ErrorBoundary fallback={errorScreen}>{element}</ErrorBoundary>
      </ThemeProvider>
    )
  })
  return host
}

function labels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).map(node => node.textContent ?? '')
}

function press(label: string): void {
  const target = Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).find(node => node.textContent === label)
  if (target == null) throw new Error(`no ${label} button`)
  target.click()
}

describe('BuildInfoModal crash-reporting tests', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    // A modal draws outside its host, so the host may already be gone.
    if (host?.parentNode != null) host.parentNode.removeChild(host)
    host = undefined
  })

  it('shows nothing extra to someone who is not an administrator', async function () {
    await render(<BuildInfoModal info={info} onClose={() => undefined} />)
    expect(labels()).not.include('Send a test error')
    expect(labels()).not.include('Test a render error')
    expect(labels()).not.include('Test a native crash')
  })

  it('gives an administrator the web tests, without a native crash on the web', async function () {
    await render(
      <BuildInfoModal
        info={info}
        onClose={() => undefined}
        isAdmin
        crash={undefined}
      />
    )
    expect(labels()).include.members([
      'Send a test error',
      'Test a render error'
    ])
    expect(labels()).not.include('Test a native crash')
  })

  it('crashes the native app on request', async function () {
    let crashes = 0
    await render(
      <BuildInfoModal
        info={info}
        onClose={() => undefined}
        isAdmin
        crash={() => {
          crashes++
        }}
      />
    )
    await act(async () => {
      press('Test a native crash')
    })
    expect(crashes).equals(1)
  })

  it('fails while drawing, so the error screen takes over', async function () {
    const realError = console.error
    console.error = () => undefined
    try {
      const container = await render(
        <BuildInfoModal info={info} onClose={() => undefined} isAdmin />
      )
      await act(async () => {
        press('Test a render error')
      })
      expect(container.textContent).contains('Something went wrong')
    } finally {
      console.error = realError
    }
  })

  it('sends a test error by throwing it', function () {
    expect(() => sendTestError()).throws('Sentry test error')
  })
})
