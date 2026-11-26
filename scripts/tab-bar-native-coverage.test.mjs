import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { tabBarNativeCounts } from './tab-bar-native-coverage.mjs'
describe('the tab bar XCTest coverage gate', () => {
  const path = 'ios/TeamStation/TSTabBarComponentView.mm'
  const root = '/workspace'
  const absolute = root + '/' + path
  it('requires the changed file from this checkout', () => {
    assert.throws(
      () => tabBarNativeCounts([path], '/other/' + path, () => ({}), root),
      /No native coverage record/
    )
  })
  it('rejects an archive with no executable counters for the source', () => {
    for (const read of [
      () => ({}),
      () => ({ [absolute]: [{ line: 1, isExecutable: false }] })
    ])
      assert.throws(
        () => tabBarNativeCounts([path], absolute, read, root),
        /No executable coverage counters/
      )
  })
  it('preserves both hit and missed executable lines', () => {
    const read = () => ({
      [absolute]: [
        { line: 1, isExecutable: false },
        { line: 2, isExecutable: true, executionCount: 3 },
        { line: 3, isExecutable: true, executionCount: 0 }
      ]
    })
    assert.deepEqual(tabBarNativeCounts([path], absolute, read, root), {
      [path]: { 2: 3, 3: 0 }
    })
  })
})
