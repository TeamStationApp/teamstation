import type { Event } from '@sentry/core'
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { buildInfo } from '../common/distribution'
import { HttpError } from '../common/errors'
import { sentryRelease } from '../common/sentry/release'
import {
  RenderErrorProbe,
  resetSentryForTest,
  type SentrySdk,
  startSentry,
  useSentryUser
} from './sentry'
import { sdkOptions, sentryHost } from './sentrySdk'

const DSN = 'https://public@sentry.example.test/1'

interface Recorded {
  options: Array<Record<string, unknown>>
  users: unknown[]
  tags: Array<[string, string]>
}

function recordingSdk(host: string | undefined): SentrySdk & Recorded {
  const sdk = {
    options: [] as Array<Record<string, unknown>>,
    users: [] as unknown[],
    tags: [] as Array<[string, string]>,
    sdkOptions: { marker: true },
    setTag: (key: string, value: string) => {
      sdk.tags.push([key, value])
    },
    init: (options: Record<string, unknown>) => {
      sdk.options.push(options)
    },
    setUser: (user: unknown) => {
      sdk.users.push(user)
    },
    sentryHost: () => host
  }
  return sdk as unknown as SentrySdk & Recorded
}

describe('startSentry', function () {
  afterEach(function () {
    resetSentryForTest()
  })

  it('reports nothing without a DSN', function () {
    const sdk = recordingSdk('app.teamstation.app')
    expect(startSentry({ dsn: '', sdk })).equals(false)
    expect(startSentry({ sdk })).equals(false)
    expect(sdk.options).length(0)
  })

  it('names a web build by its deployed version and its platform', function () {
    const sdk = recordingSdk('develop2.example.test')
    expect(startSentry({ dsn: DSN, sdk, platform: 'web' })).equals(true)
    const [options] = sdk.options
    expect(options).deep.include({
      marker: true,
      dsn: DSN,
      release: `app.teamstation.web@${buildInfo.buildNumber}`,
      environment: 'develop2'
    })
    expect(sdk.tags).deep.equals([['platform', 'web']])
    expect(startSentry({ dsn: DSN, sdk, platform: 'web' })).equals(false)
    expect(sdk.options).length(1)
  })

  it('names a phone build by its version and build number', function () {
    const sdk = recordingSdk('app.teamstation.app')
    startSentry({ dsn: DSN, sdk, platform: 'ios' })
    expect(sdk.options[0]).deep.include({
      ...sentryRelease(
        'app.teamstation.app',
        buildInfo.version,
        buildInfo.buildNumber
      ),
      environment: 'production'
    })
    expect(sdk.tags).deep.equals([['platform', 'ios']])
  })

  it('leaves out explained errors and console lines, and scrubs the rest', function () {
    const sdk = recordingSdk(undefined)
    startSentry({ dsn: DSN, sdk, platform: 'web' })
    const options = sdk.options[0] as {
      environment: string
      beforeSend: (event: Event, hint: unknown) => Event | null
      beforeBreadcrumb: (crumb: { category: string }) => unknown
    }
    expect(options.environment).equals('development')
    expect(
      options.beforeSend(
        {},
        { originalException: new HttpError('offline', 'x') }
      )
    ).equals(null)
    expect(
      options.beforeSend(
        { message: 'open /signin/abc' },
        { originalException: new Error('x') }
      )
    ).deep.equals({ message: 'open /signin/[Filtered]' })
    expect(options.beforeBreadcrumb({ category: 'console' })).equals(null)
  })
})

describe('the web SDK', function () {
  it('collects nothing about the person and reads the host from the page', function () {
    expect(sdkOptions.dataCollection).deep.include({ userInfo: false })
    expect(sentryHost()).equals(globalThis.location?.hostname)
  })
})

describe('useSentryUser', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
  })

  function Probe({
    userId,
    sdk
  }: {
    userId: number | undefined
    sdk: SentrySdk
  }): null {
    useSentryUser(userId, sdk)
    return null
  }

  it('names the signed-in account by id, and forgets it on sign-out', async function () {
    const sdk = recordingSdk(undefined)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<Probe userId={7} sdk={sdk} />)
    })
    await act(async () => {
      root?.render(<Probe userId={undefined} sdk={sdk} />)
    })
    expect(sdk.users).deep.equals([{ id: '7' }, null])
  })
})

describe('RenderErrorProbe', function () {
  it('throws the named test error', function () {
    expect(() => RenderErrorProbe()).throws('Sentry test render error')
  })
})
