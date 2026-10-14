import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { dictatingHealth, fakeDictation } from '../../test/dictationFakes'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { createDevelopmentSession } from './developmentSession'
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
})

describe('the roster chat on the roster screen', function () {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )

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
})
