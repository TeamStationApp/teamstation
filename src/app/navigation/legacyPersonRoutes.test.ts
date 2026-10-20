import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { parseRoute } from './routes'
import { currentRoute } from './useAddressBar'

describe('legacy person addresses', () => {
  const id = userIdOfGumbo(42)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  afterEach(() => {
    if (original != null) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  it('derives old player and group-person paths before loading', () => {
    expect(parseRoute('/players/42')).deep.equals({
      name: 'player',
      userId: id
    })
    for (const kind of ['team', 'season', 'league'] as const) {
      expect(parseRoute(`/${kind}s/grp_one/people/42`)).deep.equals({
        name: 'person',
        kind,
        id: 'grp_one',
        userId: id
      })
    }
    for (const bad of [
      '0',
      '01',
      '-1',
      '9007199254740992',
      '42.5',
      'garbage',
      'usr_1111111111111111111111'
    ]) {
      expect(parseRoute(`/players/${bad}`)).deep.equals({ name: 'home' })
      expect(parseRoute(`/teams/t/people/${bad}`)).deep.equals({ name: 'home' })
    }
  })
  it('replaces the address without adding a history entry or losing state/query/hash', () => {
    for (const pathname of ['/players/42', '/teams/t/people/42/']) {
      const calls: unknown[][] = []
      const state = { tsRouteIndex: 4, other: true }
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { pathname, search: '?tab=stats', hash: '#history' },
          history: {
            state,
            replaceState: (...args: unknown[]) => {
              calls.push(args)
            }
          }
        }
      })
      const route = currentRoute()
      expect(route.name).equals(
        pathname.startsWith('/players') ? 'player' : 'person'
      )
      expect(calls).deep.equals([
        [state, '', pathname.replace('42', id) + '?tab=stats#history']
      ])
    }
  })
  it('leaves canonical, unrelated and server-side addresses alone', () => {
    for (const pathname of [`/players/${id}`, '/games/42', '/players/0']) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { pathname, search: '', hash: '' },
          history: {
            replaceState: () => {
              throw new Error('unexpected replacement')
            }
          }
        }
      })
      currentRoute()
    }
    Reflect.deleteProperty(globalThis, 'window')
    expect(currentRoute()).deep.equals({ name: 'home' })
  })
})
