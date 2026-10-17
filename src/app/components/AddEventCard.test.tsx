import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { find, mount, press, unmount } from '../../test/gameFormDom'
import { AddEventCard } from './AddEventCard'

describe('schedule event creation entry card', () => {
  afterEach(unmount)
  for (const variant of ['game', 'event'] as const)
    it(`opens ${variant} creation from its labeled action`, async () => {
      let opened = 0
      await mount(
        <AddEventCard
          variant={variant}
          onPress={() => {
            opened++
          }}
        />
      )
      const label = variant === 'game' ? 'Add Game' : 'Add Event'
      expect(find(label)).not.equals(undefined)
      await press(label)
      expect(opened).equals(1)
      if (variant === 'game') {
        const button = document.querySelector(
          '[data-testid="add-game-button"]'
        )!
        expect(getComputedStyle(button).alignSelf).equals('center')
      }
    })
})
