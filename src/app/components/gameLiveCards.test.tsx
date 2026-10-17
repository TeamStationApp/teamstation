import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { RsvpScheduleRow } from './RsvpScheduleRow'
import { ScheduleRow } from './ScheduleRow'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

for (const Row of [ScheduleRow, RsvpScheduleRow]) {
  describe(`${Row.name} LIVE eligibility`, () => {
    const hour = 3600000
    async function render(patch: Record<string, unknown> = {}): Promise<void> {
      if (root == null) {
        const host = document.createElement('div')
        document.body.append(host)
        root = createRoot(host)
      }
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <Row
              first="Demo Owls"
              startAt={new Date().toISOString()}
              status="inProgress"
              isGameLive
              awayScore={null}
              homeScore={null}
              videoCount={0}
              footer={null}
              {...patch}
            />
          </ThemeProvider>
        )
      })
    }
    const visible = (): boolean =>
      document.body.textContent?.includes('LIVE') === true

    it('renders the server flag and follows refreshed false/true decisions', async () => {
      await render({ isGameLive: false })
      expect(visible()).equals(false)
      await render()
      expect(visible()).equals(true)
      await render({ isGameLive: false })
      expect(visible()).equals(false)
      for (const status of ['final', 'cancelled']) {
        await render({ status, isGameLive: false })
        expect(visible()).equals(false)
      }
    })

    it('does not recalculate the flag using the device clock', async () => {
      for (const offset of [-24 * hour, 24 * hour]) {
        await render({ startAt: new Date(Date.now() + offset).toISOString() })
        expect(visible()).equals(true)
      }
    })

    it('hides LIVE when an older server omits the flag', async () => {
      await render({ isGameLive: undefined })
      expect(visible()).equals(false)
    })
  })
}
