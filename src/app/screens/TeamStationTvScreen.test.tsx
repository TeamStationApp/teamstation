import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Linking } from 'react-native'

import { TeamStationClient } from '../../common/api'
import type { QrScannerProps } from '../scoring/qrScannerProps'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  TeamStationTvScreen,
  type TeamStationTvScreenProps,
  TvBrowserHandoff
} from './TeamStationTvScreen'

let root: Root | undefined
const pause = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 15))
}
const text = (): string => document.body.textContent ?? ''
async function render(
  client: TeamStationClient,
  token?: string,
  camera?: TeamStationTvScreenProps['camera'],
  server?: string
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <TeamStationTvScreen
          client={client}
          token={token}
          camera={camera}
          server={server}
        />
      </ThemeProvider>
    )
    await pause()
  })
}
async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    await pause()
  })
}
async function edit(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Eight-letter TV login code"]'
  )!
  expect(input).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await pause()
  })
}
function fixture(baseUrl = 'https://app.example.test/api/v1'): {
  client: TeamStationClient
  approvals: unknown[]
  inspected: string[]
} {
  const client = new TeamStationClient({
    baseUrl
  })
  const approvals: unknown[] = []
  const inspected: string[] = []
  client.approveTvLogin = async input => {
    approvals.push(input)
  }
  client.inspectTvLogin = async token => {
    inspected.push(token)
    return {
      platform: 'Apple TV',
      location: 'Example City',
      expiresAt: Date.now() + 120000
    }
  }
  return { client, approvals, inspected }
}
describe('TeamStation TV approval screen', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    root = undefined
  })

  it('offers a browser escape before local sign-in without spending credentials', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    for (const server of [
      undefined,
      'https://evil.example.test',
      'https://develop5.teamstation.app'
    ]) {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <TvBrowserHandoff server={server} token={'a'.repeat(43)} />
          </ThemeProvider>
        )
        await pause()
      })
      expect(text().includes('Open TV login in browser')).equals(
        server === 'https://develop5.teamstation.app'
      )
    }
    const original = Linking.openURL
    let opened = ''
    Linking.openURL = async url => {
      opened = url
    }
    try {
      await press('Open TV login in browser')
    } finally {
      Linking.openURL = original
    }
    expect(opened).equals(
      'https://develop5.teamstation.app/account/tv?token=' + 'a'.repeat(43)
    )
  })

  it('checks the issuer before preview and offers only a trusted browser destination', async () => {
    const f = fixture()
    f.client.issuer = async () => 'https://app.example.test/oauth'
    await render(
      f.client,
      'a'.repeat(43),
      undefined,
      'https://develop5.teamstation.app'
    )
    expect(f.inspected).length(0)
    expect(text()).contains('different TeamStation server')
    expect(text()).contains('Open in browser')
  })

  it('accepts a verified API alias and does not preview an unverifiable issuer', async () => {
    const f = fixture()
    f.client.issuer = async () => 'https://web.example.test/oauth'
    await render(
      f.client,
      'a'.repeat(43),
      undefined,
      'https://web.example.test'
    )
    expect(f.inspected).deep.equals(['a'.repeat(43)])
  })

  for (const discovery of [null, undefined]) {
    it(`keeps safe browser approval available when alias discovery is ${discovery === null ? 'disabled' : 'unavailable'}`, async () => {
      const f = fixture('https://app.teamstation.app/api/v1')
      f.client.issuer = async () => discovery
      await render(
        f.client,
        'a'.repeat(43),
        undefined,
        'https://web.teamstation.app'
      )
      expect(f.inspected).length(0)
      expect(f.approvals).length(0)
      expect(text()).includes('Open in browser')
    })
  }

  it('focuses one input, normalizes paste and submits only on the eighth letter', async () => {
    const f = fixture()
    await render(f.client)
    await press('Enter TV code')
    expect(document.activeElement?.getAttribute('aria-label')).equals(
      'Eight-letter TV login code'
    )
    await edit('abc')
    expect(f.approvals).length(0)
    await edit('ab')
    expect(f.approvals).length(0)
    await edit('abcd-efgh')
    expect(f.approvals).deep.equals([{ code: 'ABCDEFGH' }])
    expect(text()).includes('Your TV is signed in')
    await press('Connect another TV')
    expect(text()).includes('Scan QR code')
    await press('Scan QR code')
    expect(text()).includes('phone’s camera')
  })
  it('inspects a QR arrival without approving and Cancel makes no write', async () => {
    const f = fixture()
    await render(f.client, 'a'.repeat(43))
    expect(f.inspected).length(1)
    expect(f.approvals).length(0)
    expect(text()).includes('Log in to Apple TV')
    expect(text()).includes('Approximate location: Example City')
    await press('Cancel')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    expect(f.approvals).length(0)
    expect(text()).not.includes('Log in to Apple TV')
  })
  it('requires Login on a QR confirmation, handles missing location, and approves once', async () => {
    const f = fixture()
    f.client.inspectTvLogin = async () => ({
      platform: 'Google TV',
      location: null,
      expiresAt: Date.now() + 120000
    })
    await render(f.client, 'b'.repeat(43))
    expect(text()).includes('Location unavailable')
    await press('Login')
    expect(f.approvals).deep.equals([{ token: 'b'.repeat(43) }])
    expect(text()).includes('Your TV is signed in')
  })
  it('keeps an invalid code editable and shows inspection errors', async () => {
    const f = fixture()
    f.client.approveTvLogin = async () => {
      throw new Error('Expired code')
    }
    await render(f.client)
    await edit('ABCDEFGH')
    expect(text()).includes('Expired code')
    f.client.approveTvLogin = async input => {
      f.approvals.push(input)
    }
    await edit('IJKLMNOP')
    expect(f.approvals).length(1)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    f.client.inspectTvLogin = async () => {
      throw new Error('Expired QR')
    }
    await render(f.client, 'c'.repeat(43))
    expect(text()).includes('Expired QR')
  })
  it('disables Login after expiry', async () => {
    const f = fixture()
    f.client.inspectTvLogin = async () => ({
      platform: 'Apple TV',
      location: null,
      expiresAt: Date.now() - 1
    })
    await render(f.client, 'd'.repeat(43))
    expect(text()).includes('This code has expired')
    await press('Login')
    expect(f.approvals).length(0)
    await press('Cancel')
  })
  it('handles camera denial, unavailable hardware, malformed and valid QR scans', async () => {
    const f = fixture()
    let props: QrScannerProps | undefined
    const camera = {
      supported: true,
      View: (p: QrScannerProps) => {
        props = p
        return null
      }
    }
    await render(f.client, undefined, camera)
    for (const status of ['denied', 'unavailable'] as const) {
      await press('Scan QR code')
      await act(async () => {
        props!.onStatus(status)
        await pause()
      })
      expect(text()).includes(
        status === 'denied'
          ? 'Camera access is disabled'
          : 'No camera is available'
      )
    }
    await press('Scan QR code')
    await act(async () => {
      props!.onStatus('ready')
      props!.onCode(
        'https://evil.example.test/tv-login?token=' + 'a'.repeat(43)
      )
      await pause()
    })
    expect(text()).includes('not a TeamStation TV QR code')
    await press('Scan QR code')
    await act(async () => {
      props!.onCode(
        'https://app.teamstation.app/tv-login?token=' + 'a'.repeat(43)
      )
      await pause()
    })
    expect(f.inspected).length(1)
    expect(f.approvals).length(0)
    await press('Login')
    expect(f.approvals).length(1)
  })
  for (const server of [
    'https://develop.teamstation.app',
    'https://develop5.teamstation.app',
    'http://192.168.1.2:9100'
  ]) {
    it(`scans a TV link on the configured browser server ${server}`, async () => {
      const f = fixture(server + '/api/v1')
      let scanner: QrScannerProps | undefined
      const camera = {
        supported: true,
        View: (props: QrScannerProps) => {
          scanner = props
          return null
        }
      }
      await render(f.client, undefined, camera)
      await press('Scan QR code')
      await act(async () => {
        const host = server.startsWith('https:') ? 'develop' : 'app'
        scanner!.onCode(
          `https://${host}.teamstation.app/tv-login?token=${'a'.repeat(43)}&server=${encodeURIComponent(server)}`
        )
        await pause()
      })
      expect(f.inspected).length(1)
      expect(f.approvals).length(0)
      expect(text()).includes('Sign this TV in to your TeamStation account?')
    })
  }
  it('prevents duplicate approvals during a request and drops completion after unmount', async () => {
    const f = fixture()
    let done: (() => void) | undefined
    f.client.approveTvLogin = async input => {
      f.approvals.push(input)
      await new Promise<void>(resolve => {
        done = resolve
      })
    }
    await render(f.client)
    await edit('ABCDEFGH')
    await edit('IJKLMNOP')
    expect(f.approvals).length(1)
    expect(text()).includes('Connecting…')
    await act(async () => {
      root!.unmount()
      root = undefined
      done!()
      await pause()
    })
  })
  it('drops inspection results after unmount and allows retry after QR approval fails', async () => {
    const f = fixture()
    let done: (() => void) | undefined
    f.client.inspectTvLogin = async () => {
      await new Promise<void>(resolve => {
        done = resolve
      })
      return {
        platform: 'Apple TV',
        location: null,
        expiresAt: Date.now() + 120000
      }
    }
    await render(f.client, 'a'.repeat(43))
    await act(async () => {
      root!.unmount()
      root = undefined
      done!()
      await pause()
    })
    f.client.inspectTvLogin = async () => ({
      platform: 'Apple TV',
      location: null,
      expiresAt: Date.now() + 120000
    })
    f.client.approveTvLogin = async () => {
      throw new Error('Retry this TV')
    }
    await render(f.client, 'b'.repeat(43))
    await press('Login')
    expect(text()).includes('Retry this TV')
    f.client.approveTvLogin = async input => {
      f.approvals.push(input)
    }
    await press('Login')
    expect(f.approvals).length(1)
  })
})
