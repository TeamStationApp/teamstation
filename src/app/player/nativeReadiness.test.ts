import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  nextReadiness,
  NOTHING_LOADED,
  type ReadinessEvent
} from './nativeReadiness'

const ANDROID = { readyOnBuffer: true }
const IOS = { readyOnBuffer: false }

/** The readyState after each event, from nothing loaded. */
function states(
  events: ReadinessEvent[],
  rules: { readyOnBuffer: boolean }
): number[] {
  let readiness = NOTHING_LOADED
  return events.map(event => {
    readiness = nextReadiness(readiness, event, rules)
    return readiness.state
  })
}

describe('a native player’s readiness', function () {
  const rows: Array<{
    name: string
    rules: { readyOnBuffer: boolean }
    events: ReadinessEvent[]
    expected: number[]
  }> = [
    {
      name: 'ExoPlayer’s first open: picture and buffer-ready before the load',
      rules: ANDROID,
      events: ['loadStart', 'picture', 'bufferEnd', 'load'],
      expected: [0, 4, 4, 4]
    },
    {
      name: 'ExoPlayer opening the item again by itself',
      rules: ANDROID,
      events: [
        'loadStart',
        'picture',
        'bufferEnd',
        'load',
        'loadStart',
        'picture',
        'bufferEnd',
        'load'
      ],
      expected: [0, 4, 4, 4, 0, 4, 4, 4]
    },
    {
      name: 'ExoPlayer, loaded with no picture yet, ready on its buffer',
      rules: ANDROID,
      events: ['loadStart', 'load', 'bufferEnd'],
      expected: [0, 1, 4]
    },
    {
      name: 'AVPlayer’s first load, then its picture',
      rules: IOS,
      events: ['loadStart', 'load', 'bufferEnd', 'picture'],
      expected: [0, 1, 1, 4]
    },
    {
      name: 'AVPlayer’s picture ahead of its first load',
      rules: IOS,
      events: ['picture', 'load'],
      expected: [4, 4]
    },
    {
      name: 'AVPlayer loading the same item again: nothing drawn yet',
      rules: IOS,
      events: ['load', 'picture', 'loadStart', 'load', 'picture'],
      expected: [1, 4, 4, 1, 4]
    },
    {
      name: 'running short and having enough again, on either platform',
      rules: IOS,
      events: ['load', 'picture', 'bufferStart', 'bufferEnd'],
      expected: [1, 4, 2, 4]
    },
    {
      name: 'running short on Android',
      rules: ANDROID,
      events: ['loadStart', 'picture', 'load', 'bufferStart', 'bufferEnd'],
      expected: [0, 4, 4, 2, 4]
    },
    {
      name: 'a buffer-ready report before anything is loaded',
      rules: ANDROID,
      events: ['bufferEnd', 'bufferStart', 'bufferEnd'],
      expected: [0, 0, 0]
    },
    {
      name: 'a reload or new source, whatever was held, then its first load',
      rules: IOS,
      events: ['load', 'picture', 'reopen', 'picture', 'load'],
      expected: [1, 4, 0, 4, 4]
    }
  ]
  for (const row of rows) {
    it(row.name, function () {
      expect(states(row.events, row.rules)).deep.equals(row.expected)
    })
  }
})
