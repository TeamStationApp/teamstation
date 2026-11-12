import { expect } from 'chai'

import {
  auditListeners,
  describeListeners,
  disallowed,
  parseLsof,
  processTree
} from './listeners'

describe('the listener audit', function () {
  const lsof = [
    'p100',
    'cnode',
    'n*:9102',
    'p200',
    'cGoogle Chrome for Testing',
    'n127.0.0.1:53111',
    'n[::1]:53112',
    'p300',
    'cGoogle Chrome for Testing',
    'n*:9222',
    ''
  ].join('\n')

  it('reads lsof field output', function () {
    expect(parseLsof(lsof)).deep.equals([
      { pid: 100, command: 'node', address: '*:9102' },
      {
        pid: 200,
        command: 'Google Chrome for Testing',
        address: '127.0.0.1:53111'
      },
      {
        pid: 200,
        command: 'Google Chrome for Testing',
        address: '[::1]:53112'
      },
      { pid: 300, command: 'Google Chrome for Testing', address: '*:9222' }
    ])
  })

  it('allows only a browser on loopback, and names the rest', function () {
    const bad = disallowed(parseLsof(lsof))
    expect(bad.map(listener => listener.pid)).deep.equals([100, 300])
    expect(describeListeners(bad)).equals(
      'node[100] *:9102, Google Chrome for Testing[300] *:9222'
    )
  })

  it('walks the whole process tree once', function () {
    const tree: Record<number, number[]> = { 1: [2, 3], 2: [4], 3: [4], 4: [] }
    expect(processTree(1, pid => tree[pid] ?? [])).deep.equals([1, 2, 3, 4])
  })

  it('finds nothing listening under this test process', function () {
    expect(auditListeners()).deep.equals([])
  })
})
