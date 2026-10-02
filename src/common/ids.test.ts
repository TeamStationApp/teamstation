import { expect } from 'chai'
import { describe, it } from 'mocha'

import { idPrefixes, isId, makeId } from './ids'

describe('ids', function () {
  it('prefixes every kind distinctly', function () {
    const prefixes = Object.values(idPrefixes)
    expect(new Set(prefixes).size).equals(prefixes.length)
  })

  it('makes ids that are recognisably their own kind', function () {
    const id = makeId('user')
    expect(id.startsWith('usr_')).equals(true)
    expect(isId('user', id)).equals(true)
    expect(isId('team', id)).equals(false)
  })

  it('does not repeat itself', function () {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(makeId('event'))
    expect(seen.size).equals(1000)
  })

  it('stays safe in a URL path', function () {
    for (const kind of Object.keys(idPrefixes) as Array<
      keyof typeof idPrefixes
    >) {
      const id = makeId(kind)
      expect(encodeURIComponent(id)).equals(id)
    }
  })

  it('rejects a bare prefix', function () {
    expect(isId('user', 'usr_')).equals(false)
  })
})
