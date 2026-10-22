import { expect } from 'chai'
import { describe, it } from 'mocha'

import { stacksAfterTabPress } from './tabPress'

type Tab = 'home' | 'videos' | 'schedule'

const deep = (): Record<Tab, string[]> => ({
  home: ['team', 'game'],
  videos: ['game'],
  schedule: []
})

describe('a press on a destination', function () {
  it('clears the tab you are already on, in one press', function () {
    const stacks = {
      home: ['team', 'game', 'player'],
      videos: ['game'],
      schedule: []
    }
    const once = stacksAfterTabPress(stacks, 'home', 'home')
    expect(once.home).deep.equals([])
    expect(once.videos).deep.equals(['game'])
    expect(once.schedule).deep.equals([])
  })

  it('changes nothing when the press is for another tab', function () {
    // Each tab keeps its place: a team opened from Home is still open on the
    // way back from Videos.
    const stacks = deep()
    expect(stacksAfterTabPress(stacks, 'home', 'videos')).equals(stacks)
  })

  it('hands back the same record at the root, so nothing re-renders', function () {
    const stacks = deep()
    // Not merely equal — identical, or the screen already on show is redrawn
    // every time somebody presses the tab it belongs to.
    expect(stacksAfterTabPress(stacks, 'schedule', 'schedule')).equals(stacks)
  })
})
