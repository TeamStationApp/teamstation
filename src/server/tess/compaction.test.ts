import { expect } from 'chai'
import { describe, it } from 'mocha'

import { contextLimits } from './compaction'
import { MAX_TOKENS } from './messagesApi'

describe('Tess context budgets', () => {
  it('retains 750K tokens before compacting Sonnet 5.5 and reserves its answer', () => {
    expect(contextLimits('claude-sonnet-5-5')).deep.equals({
      compactAbove: 750000,
      inputCeiling: 1000000 - MAX_TOKENS
    })
  })

  it('keeps the smaller budget for older or unverified model overrides', () => {
    for (const model of ['claude-sonnet-4-5', 'custom-model', ''])
      expect(contextLimits(model)).deep.equals({
        compactAbove: 150000,
        inputCeiling: 200000 - MAX_TOKENS
      })
  })
})
