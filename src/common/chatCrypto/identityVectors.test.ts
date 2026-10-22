import { expect } from 'chai'
import { describe, it } from 'mocha'

import { call } from './core'
import { runIdentityVectors } from './identityVectors'

describe('shared canonical identity vectors', () => {
  it('reports a refused full-width construction instead of accepting its other passing vectors', () => {
    const results = runIdentityVectors((op, args) => {
      if (op === 'sealMessage' && args[3].length === 17)
        throw new Error('Unsupported full-width identity')
      return call(op, args)
    })
    const refused = results.filter(result => !result.ok)
    expect(refused).length(5)
    expect(refused.every(result => result.name.endsWith(' seal'))).equals(true)
    expect(refused.every(result => result.got === 'refused')).equals(true)
    expect(
      results.some(result => result.name === 'identity 1 seal' && result.ok)
    ).equals(true)
  })
})
