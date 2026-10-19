import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringState } from './scoringTypes'
import {
  RunnerRosterSheet,
  TiebreakerBases,
  TiebreakerSetupSheet
} from './TiebreakerSheets'
import { useTiebreakerSetup } from './useTiebreakerSetup'

let root: Root | undefined
let control: ReturnType<typeof useTiebreakerSetup>
let current: ScoringState
let setGame: (state: ScoringState) => void
let setAllowed: (allowed: boolean) => void
let dispatched = 0
function Harness(): React.ReactElement {
  const [state, setState] = useState(() =>
    initialScoringState(scoringSession(gameFixture))
  )
  const [allowed, allow] = useState(true)
  current = state
  setGame = setState
  setAllowed = allow
  control = useTiebreakerSetup(state, allowed, event => {
    dispatched++
    setState(previous => scoringReducer(previous, event))
  })
  return <div />
}
const step = async (run: () => void): Promise<void> => {
  await act(async () => {
    run()
  })
}
async function mount(children: React.ReactNode = <Harness />): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await step(() => {
    root!.render(<ThemeProvider>{children}</ThemeProvider>)
  })
}
describe('tiebreaker selection lifecycle', () => {
  afterEach(async () => {
    await step(() => root?.unmount())
    root = undefined
    dispatched = 0
  })
  it('reports stale players and occupied-base failures, and safely ignores invalid or inactive selections', async () => {
    await mount()
    await step(() => {
      control.handleChooseBase(1)
    })
    await step(() => {
      control.handleChooseRunner(9)
    })
    await step(() => {
      control.handleSetOuts(2)
    })
    expect(dispatched).equals(0)
    await step(() => {
      control.handleOpen()
    })
    await step(() => {
      control.handlePlace()
    })
    await step(() => {
      control.handleChooseBase(0)
    })
    expect(control.mode).equals('bases')
    await step(() => {
      control.handleChooseBase(2)
    })
    await step(() => {
      control.handleChooseRunner(1)
    })
    expect(control.problem).includes('no longer available')
    expect(dispatched).equals(0)
    await step(() => {
      setGame(
        scoringReducer(current, {
          type: 'MORE',
          input: { action: 'Place a Runner (Tiebreaker)', playerId: 9, base: 2 }
        })
      )
    })
    await step(() => {
      control.handleChooseRunner(8)
    })
    expect(control.problem).includes('empty base')
    expect(control.mode).equals(2)
    await step(() => {
      control.handleBack()
    })
    await step(() => {
      control.handleChooseBase(2)
    })
    expect(control.mode).equals('bases')
    await step(() => {
      control.handleChooseBase(1)
    })
    await step(() => {
      control.handleChooseRunner(8)
    })
    expect(control.mode).equals('settings')
    expect(dispatched).equals(1)
    await step(() => {
      control.handleSetOuts(2)
    })
    expect(current.session.liveData.linescore.outs).equals(2)
    await step(() => {
      control.handleClose()
    })
    expect(control.active).equals(false)
  })
  for (const changed of ['permission', 'pitch', 'bottom'] as const)
    it(`dismisses immediately and rejects a stale runner callback after a ${changed} change`, async () => {
      await mount()
      await step(() => {
        control.handleOpen()
      })
      await step(() => {
        control.handlePlace()
      })
      await step(() => {
        control.handleChooseBase(1)
      })
      const stale = control.handleChooseRunner
      await step(() => {
        if (changed === 'permission') setAllowed(false)
        else if (changed === 'pitch')
          setGame(scoringReducer(current, { type: 'PITCH', kind: 'ball' }))
        else
          setGame({
            ...current,
            session: {
              ...current.session,
              liveData: {
                ...current.session.liveData,
                linescore: {
                  ...current.session.liveData.linescore,
                  isTopInning: false
                }
              }
            }
          })
      })
      expect(control.active).equals(false)
      expect(control.mode).equals(undefined)
      await step(() => {
        stale(9)
        control.handlePlace()
        control.handleBack()
        control.handleOpen()
        control.handleChooseBase(3)
        control.handleSetOuts(1)
      })
      expect(dispatched).equals(0)
    })

  it('renders no home target, keeps large dashed targets within the viewport and honors disabled occupied bases', async () => {
    let chosen = 0
    let canceled = false
    await mount(
      <TiebreakerBases
        projection={{
          width: 390,
          height: 844,
          bases: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 900, y: 900 },
            { x: 195, y: 430 }
          ]
        }}
        occupied={[null, 2, null]}
        onChoose={base => {
          chosen = base
        }}
        onCancel={() => {
          canceled = true
        }}
      />
    )
    expect(
      document.querySelectorAll('[aria-label^="Place runner on "]')
    ).has.length(3)
    const first = document.querySelector<HTMLElement>(
      '[aria-label="Place runner on 1B"]'
    )!
    expect(first.style.left).equals('0px')
    expect(first.style.top).equals('0px')
    expect(first.style.width).equals('56px')
    expect(first.style.height).equals('48px')
    expect(window.getComputedStyle(first).borderTopStyle).equals('dashed')
    const second = document.querySelector<HTMLElement>(
      '[aria-label="Place runner on 2B"]'
    )!
    expect(second.style.left).equals('334px')
    expect(second.style.top).equals('796px')
    await step(() => {
      second.click()
    })
    expect(chosen).equals(0)
    await step(() => {
      first.click()
    })
    expect(chosen).equals(1)
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Cancel runner placement"]')!
        .click()
    })
    expect(canceled).equals(true)
  })
  it('shows an empty runner roster and actionable setup errors without fabricating a player', async () => {
    const session = scoringSession(gameFixture)
    session.liveData.boxscore.teams.away.battingOrder = []
    await mount(
      <RunnerRosterSheet
        session={session}
        base={3}
        onChoose={() => undefined}
        onClose={() => undefined}
        problem="Try another base"
      />
    )
    expect(document.body.textContent).includes(
      'No eligible players in the batting order.'
    )
    expect(document.body.textContent).includes('Try another base')
    await step(() => {
      root!.render(
        <ThemeProvider>
          <TiebreakerSetupSheet
            outs={1}
            problem="Please try again"
            onClose={() => undefined}
            onPlace={() => undefined}
            onOuts={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).includes('Please try again')
  })
})
