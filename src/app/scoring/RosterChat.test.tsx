import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { dictatingHealth, fakeDictation } from '../../test/dictationFakes'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { AskCard } from './DictationButton'
import { MESSAGE_COLOR, SAID_COLOR } from './dictationControls'
import { gameFixture } from './isUnscoredGame.test'
import { type ChatTurn, RosterChat } from './RosterChat'
import { RosterEditor } from './RosterEditor'
import { initialScoringState } from './scoringMachine'

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
})
async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
const all = (testId: string): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
]
const node = (label: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
/** The colour as the browser reports it, for comparing with a theme's hex. */
function rgb(hex: string): string {
  const probe = document.createElement('div')
  probe.style.color = hex
  return probe.style.color
}

describe('the roster chat', function () {
  const turns: ChatTurn[] = [
    {
      key: 0,
      said: 'Put Judge fourth',
      lines: [{ kind: 'done', text: 'Judge to 4th in the lineup' }]
    },
    {
      key: 1,
      said: 'Put Judge leadoff and Soto at short',
      lines: [
        {
          kind: 'problem',
          text: 'Say roster, lineup and defense changes one at a time'
        }
      ]
    }
  ]

  it('draws nothing before the first dictation', async function () {
    await render(<RosterChat turns={[]} />)
    expect(node('Dictation chat')).equals(null)
  })

  it('puts what was said on the right in white, and what was done below it on the left', async function () {
    await render(<RosterChat turns={turns} />)
    const panel = node('Dictation chat')!
    expect(getComputedStyle(panel).borderTopColor).equals(
      rgb(tsBallpark.scoringInstructionBorder)
    )
    const said = all('Roster chat said')
    expect(said.map(each => each.textContent)).deep.equals([
      'Put Judge fourth',
      'Put Judge leadoff and Soto at short'
    ])
    expect(getComputedStyle(said[0]).textAlign).equals('right')
    expect(getComputedStyle(said[0]).color).equals(rgb(SAID_COLOR))
    const [done] = all('Roster chat line')
    expect(done.textContent).equals('Judge to 4th in the lineup')
    expect(getComputedStyle(done).textAlign).equals('left')
    expect(getComputedStyle(done).color).equals(
      rgb(tsBallpark.scoringCountdownColor)
    )
    // Below the words it answers.
    expect(
      said[0].compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    const [problem] = all('Roster chat problem')
    expect(getComputedStyle(problem).color).equals(rgb(MESSAGE_COLOR))
  })

  it('keeps every turn, and draws a question inside it', async function () {
    let chosen = -1
    await render(
      <RosterChat
        turns={turns}
        ask={
          <AskCard
            question="Which Freeman?"
            options={['Away', 'Home']}
            onChoose={index => {
              chosen = index
            }}
            onDismiss={() => undefined}
          />
        }
      />
    )
    expect(all('Roster chat said')).has.length(2)
    const panel = node('Dictation chat')!
    const question = node('Dictation question')!
    expect(panel.contains(question)).equals(true)
    expect(question.textContent).includes('Which Freeman?')
    await act(async () => {
      node('Home')!.click()
    })
    expect(chosen).equals(1)
  })

  it('closes on its X or a tap on its turns, but not on the question’s buttons', async function () {
    let closed = 0
    let chosen = -1
    let dismissed = 0
    const draw = async (onClose?: () => void): Promise<void> => {
      await render(
        <RosterChat
          turns={turns}
          onClose={onClose}
          ask={
            <AskCard
              question="Which Freeman?"
              options={['Away', 'Home']}
              onChoose={index => {
                chosen = index
              }}
              onDismiss={() => {
                dismissed++
              }}
            />
          }
        />
      )
    }
    await draw(() => {
      closed++
    })
    const press = async (target: HTMLElement): Promise<void> => {
      await act(async () => {
        target.click()
      })
    }
    await press(node('Home')!)
    await press(node('Dismiss question')!)
    expect([chosen, dismissed, closed]).deep.equals([1, 1, 0])
    const close = node('Close dictation')!
    expect(close.getAttribute('role')).equals('button')
    expect(close.style.position).equals('absolute')
    await press(close)
    expect(closed).equals(1)
    await press(all('Roster chat said')[0])
    await press(all('Roster chat problem')[0])
    expect(closed).equals(3)
    // A shadow, as it floats over the screen.
    expect(node('Dictation chat')!.style.boxShadow).not.equals('')
    // The box is no button and takes no focus, so a screen reader reaches
    // the question's buttons and the X each on its own.
    const box = node('Dictation chat')!
    expect(box.getAttribute('role')).equals(null)
    expect(box.getAttribute('tabindex')).not.equals('0')
    for (const label of ['Home', 'Away', 'Dismiss question', 'Close dictation'])
      expect(node(label)!.getAttribute('tabindex'), label).equals('0')
    // Nothing to close it with, no X.
    await draw()
    expect(node('Close dictation')).equals(null)
  })
})

describe('the roster chat on the roster screen', function () {
  const state = initialScoringState(scoringSession(gameFixture))

  /** A coach's screen, which stays open through Save and Cancel. */
  async function coachScreen(): Promise<{
    say: () => Promise<void>
    reloads: () => number
  }> {
    const fake = fakeDictation()
    let reloads = 0
    await render(
      <RosterEditor
        state={state}
        audience="coach"
        fixedSide="away"
        dictate={{
          health: dictatingHealth,
          url: 'ws://host/api/v1/dictation',
          gameId: 'g1',
          log: [],
          startEnabled: true,
          tapMs: 0,
          tailMs: 0,
          openSocket: fake.openSocket,
          openMicrophone: fake.openMicrophone
        }}
        onReload={() => {
          reloads++
        }}
        onSave={() => undefined}
      />
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      fake.socket().open()
    })
    return {
      reloads: () => reloads,
      say: async () => {
        for (const type of ['pointerdown', 'pointerup'])
          await act(async () => {
            node('Dictation')!.dispatchEvent(
              new window.MouseEvent(type, { bubbles: true })
            )
          })
        const start = fake
          .socket()
          .frames.filter(f => f.kind === 'start')
          .at(-1)!
        await act(async () => {
          fake.socket().reply({
            kind: 'actions',
            id: start.id,
            transcript: 'Put the leadoff man fourth',
            actions: [],
            roster: [
              {
                type: 'placeInLineup',
                side: 'away',
                places: [{ player: { jersey: '1' }, slot: 4 }]
              }
            ],
            dropped: []
          })
        })
      }
    }
  }

  it('opens with the first dictation and closes on Save Rosters', async function () {
    const screen = await coachScreen()
    expect(node('Dictation chat')).equals(null)
    await screen.say()
    expect(node('Dictation chat')).not.equals(null)
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(node('Dictation chat')).equals(null)
  })

  it('stays open on a coach’s Cancel, saying the changes were discarded', async function () {
    const screen = await coachScreen()
    await screen.say()
    await screen.say()
    expect(all('Roster chat said')).has.length(2)
    await act(async () => {
      node('Cancel')!.click()
    })
    expect(screen.reloads()).equals(1)
    expect(all('Roster chat said')).has.length(2)
    expect(all('Roster chat line').at(-1)!.textContent).equals(
      'Changes discarded'
    )
    expect(node('Save Rosters')!.getAttribute('aria-disabled')).equals('true')
  })

  it('says nothing on a Cancel before any dictation', async function () {
    const screen = await coachScreen()
    await act(async () => {
      node('Cancel')!.click()
    })
    expect(screen.reloads()).equals(1)
    expect(node('Dictation chat')).equals(null)
  })

  it('floats over the screen, and its X or a tap closes it with the change still staged; the next dictation opens it again', async function () {
    const screen = await coachScreen()
    const top = (): HTMLElement =>
      host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
    const before = top().previousElementSibling
    await screen.say()
    const overlay = host.querySelector<HTMLElement>(
      '[data-testid="Roster chat overlay"]'
    )!
    expect(overlay.style.position).equals('absolute')
    expect(overlay.contains(node('Dictation chat'))).equals(true)
    // The content keeps its place: nothing new is laid out above it.
    expect(top().previousElementSibling).equals(before)
    expect(overlay.contains(top())).equals(false)
    const saved = (): string | null =>
      node('Save Rosters')!.getAttribute('aria-disabled')
    expect(saved()).equals(null)
    await act(async () => {
      node('Close dictation')!.click()
    })
    expect(node('Dictation chat')).equals(null)
    expect(saved()).equals(null)
    await screen.say()
    expect(all('Roster chat said')).has.length(1)
    await act(async () => {
      all('Roster chat said')[0].click()
    })
    expect(node('Dictation chat')).equals(null)
    // A note opens nothing while it is closed.
    await act(async () => {
      node('Cancel')!.click()
    })
    expect(node('Dictation chat')).equals(null)
  })

  it('answers the question it opens with, or dismisses it on closing', async function () {
    const home = state.session.liveData.boxscore.teams.home
    const third = home.battingOrder[2]
    const open = async (): Promise<void> => {
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host?.remove()
      const fake = fakeDictation()
      await render(
        <RosterEditor
          state={state}
          audience="coach"
          fixedSide="home"
          initialDraft={{
            draft: state.session,
            side: 'home',
            mode: 'defense',
            chat: [{ key: 0, said: 'Number 3 plays third', lines: [] }],
            question: {
              question: 'Which #3?',
              options: [
                {
                  label: 'This #3',
                  side: 'home',
                  commands: [
                    {
                      type: 'setPositions',
                      side: 'home',
                      places: [{ player: third, position: '3B' }]
                    }
                  ]
                }
              ]
            }
          }}
          dictate={{
            health: dictatingHealth,
            url: 'ws://host/api/v1/dictation',
            gameId: 'g1',
            log: [],
            startEnabled: true,
            tapMs: 0,
            tailMs: 0,
            openSocket: fake.openSocket,
            openMicrophone: fake.openMicrophone
          }}
          onSave={() => undefined}
        />
      )
    }
    await open()
    expect(node('Dictation question')).not.equals(null)
    await act(async () => {
      node('This #3')!.click()
    })
    expect(node('Dictation question')).equals(null)
    expect(all('Roster chat line')[0].textContent).includes('to 3B')
    expect(node('Dictation chat')).not.equals(null)
    await open()
    await act(async () => {
      node('Close dictation')!.click()
    })
    expect(node('Dictation chat')).equals(null)
    expect(node('Dictation question')).equals(null)
  })
})
