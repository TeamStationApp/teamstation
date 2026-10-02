import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import { act } from 'react'

import { startWeb } from './index'

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
      'register GameStation',
      'run GameStation into #root'
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
