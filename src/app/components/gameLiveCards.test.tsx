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
              hasScoringEvents
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

    it('requires remaining scoring and removes LIVE after undo or finalization', async () => {
      await render({ hasScoringEvents: false })
      expect(visible()).equals(false)
      await render()
      expect(visible()).equals(true)
      await render({ hasScoringEvents: false })
      expect(visible()).equals(false)
      for (const status of ['final', 'cancelled']) {
        await render({ status })
        expect(visible()).equals(false)
      }
    })

    it('hides stale and future in-progress games even with scoring', async () => {
      for (const offset of [-24 * hour, 24 * hour]) {
        await render({ startAt: new Date(Date.now() + offset).toISOString() })
        expect(visible()).equals(false)
      }
    })

    it('expires while mounted using the explicit end rather than the fallback', async () => {
      await render({
        startAt: new Date(Date.now() - 2 * hour).toISOString(),
        endAt: new Date(Date.now() - hour + 200).toISOString()
      })
      expect(visible()).equals(true)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 260))
      })
      expect(visible()).equals(false)
    })
  })
}
