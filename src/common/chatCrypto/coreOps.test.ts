import { expect } from 'chai'
import { describe, it } from 'mocha'

import { OP, REFUSALS } from './coreOps'
import opsFile from './ops.json'

describe('chat crypto core ops', () => {
  it('match ops.json, number for number', () => {
    expect(Object.entries(OP)).deep.equals(
      opsFile.ops.map(op => [op.name, op.id])
    )
    expect([...REFUSALS]).deep.equals(opsFile.refusals)
  })
})
