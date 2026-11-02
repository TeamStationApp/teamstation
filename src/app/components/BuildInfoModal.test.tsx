import { ErrorBoundary } from '@sentry/react'
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { BuildInfoModal, localBuildTime, sendTestError } from './BuildInfoModal'
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

describe('BuildInfoModal rows', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    if (host?.parentNode != null) host.parentNode.removeChild(host)
    host = undefined
  })

  it('shows the first six characters of the commit, and no more', async function () {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    await render(
      <BuildInfoModal
        onClose={() => undefined}
        info={{ ...info, commit, builtAt: '2026-10-08T07:30:00.000Z' }}
      />
    )
    const text = document.body.textContent ?? ''
    expect(text).contains('012345')
    expect(text).not.contains('0123456')
  })

  it('keeps the placeholders of a build with no information', async function () {
    await render(
      <BuildInfoModal
        onClose={() => undefined}
        info={{ ...info, commit: '—', builtAt: '—' }}
      />
    )
    const text = document.body.textContent ?? ''
    expect(text).contains('Commit—')
    expect(text).contains('Built—')
  })
})

describe('BuildInfoModal localBuildTime', function () {
  const at = '2026-10-08T07:30:00.000Z'

  it('writes the time in the zone it is given, and names the zone', function () {
    const west = localBuildTime(at, 'America/Los_Angeles')
    const east = localBuildTime(at, 'America/New_York')
    expect(west).matches(/12:30/)
    expect(west).matches(/PDT/)
    expect(east).matches(/3:30/)
    expect(east).matches(/EDT/)
  })

  it('uses the device zone when given none', function () {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(localBuildTime(at)).equals(localBuildTime(at, zone))
  })

  it('leaves anything that is not a date alone', function () {
    expect(localBuildTime('—')).equals('—')
    expect(localBuildTime('not a date')).equals('not a date')
  })
})
