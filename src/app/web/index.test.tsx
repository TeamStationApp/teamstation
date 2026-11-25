import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { act } from 'react'

import { boot } from './index'
import { startWeb } from './render'

function page(
  path: string,
  search = ''
): {
  root: HTMLElement
  calls: string[]
  start: () => 'scoreboard' | 'app'
} {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  const calls: string[] = []
  return {
    root,
    calls,
    start: () =>
      startWeb({
        document,
        location: {
          pathname: path,
          search,
          protocol: 'http:',
          host: 'localhost'
        },
        apiBaseUrl: '/api/v1',
        registry: {
          registerComponent: name => {
            calls.push(`register ${name}`)
            return name
          },
          runApplication: (name, parameters) => {
            calls.push(
              `run ${name} ${(parameters as { rootTag: unknown }).rootTag === root ? 'into #root' : 'elsewhere'}`
            )
          }
        }
      })
  }
}

afterEach(function () {
  for (const element of [document.documentElement, document.body]) {
    element.style.background = ''
    element.style.margin = ''
  }
})

describe('the web entry', function () {
  it('draws the sample on /scoreboard-sample, transparent, without the app', async function () {
    const { root, calls, start } = page('/scoreboard-sample')
    let started = ''
    await act(async () => {
      started = start()
    })
    expect(started).equals('scoreboard')
    expect(calls).deep.equals([])
    expect(
      root.querySelector('[data-scoreboard="awayTeam"]')?.textContent
    ).equals('VISITORS')
    for (const element of [document.documentElement, document.body, root]) {
      expect(getComputedStyle(element).backgroundColor).equals(
        'rgba(0, 0, 0, 0)'
      )
      expect(element.style.margin).equals('0px')
    }
  })

  it('runs the app as before on /games/g1', function () {
    const { calls, start } = page('/games/g1')
    expect(start()).equals('app')
    expect(calls).deep.equals([
      'register TeamStation',
      'run TeamStation into #root'
    ])
    expect(document.body.style.background).equals('')
  })

  it('refuses a page with no #root', function () {
    expect(() =>
      startWeb({
        document,
        location: {
          pathname: '/',
          search: '',
          protocol: 'http:',
          host: 'localhost'
        },
        apiBaseUrl: '/api/v1'
      })
    ).throws('The page has no #root')
  })
})

describe('web bootstrap', () => {
  for (const mode of [
    'normal',
    'production build',
    'wrong host',
    'frame',
    'development'
  ]) {
    it('dispatches ' + mode + ' before starting the application', async () => {
      const actions: string[] = []
      const page = Object.assign(new EventTarget(), {
        location: {
          pathname: mode === 'normal' ? '/games/g1' : '/password-login',
          origin:
            mode === 'wrong host'
              ? 'https://example.test'
              : 'https://develop.teamstation.app',
          reload: () => actions.push('reload'),
          hash: '#auth=sentinel'
        },
        history: {
          replaceState(_state: unknown, _title: string, path: string) {
            actions.push(path)
          }
        },
        top: {}
      })
      if (mode !== 'frame') page.top = page
      await boot(
        page as unknown as Window,
        async () => {
          actions.push('app')
        },
        mode === 'production build'
          ? undefined
          : async (params, signal) => {
              expect(params.get('auth')).equals('sentinel')
              expect(signal.aborted).equals(false)
              page.dispatchEvent(new Event('pagehide'))
              expect(signal.aborted).equals(true)
              actions.push('link')
            }
      )
      for (const key of ['unrelated', 'teamstation.account-switch']) {
        page.dispatchEvent(Object.assign(new Event('storage'), { key }))
      }
      expect(actions).deep.equals(
        mode === 'normal'
          ? ['app', 'reload']
          : ['/sign-in', mode === 'development' ? 'link' : 'app']
      )
    })
  }
})
