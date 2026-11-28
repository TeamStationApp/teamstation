import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { Node } from './app/keyboardDock'
import { labelOf } from './coach/coachApp'
import { buttonPoint, signOutAfterLaunch } from './scoringMobile'

/** The iPad's deck after a peer's Ball, as its accessibility tree lists it. */
function deck(ballEnabled = true): Node {
  const tree: Node = {
    type: 'Other',
    id: 'scoring-deck',
    bounds: { x: 8, y: 586, width: 458, height: 121 },
    children: [
      {
        type: 'Button',
        id: 'Undo Ball',
        text: 'Undo Ball',
        bounds: { x: 102, y: 586, width: 271, height: 57 },
        children: [
          {
            type: 'StaticText',
            id: 'scoring-control-label',
            text: 'Ball',
            bounds: { x: 154, y: 599, width: 30, height: 16 }
          }
        ]
      },
      {
        type: 'Button',
        id: 'Ball',
        text: 'Ball',
        bounds: { x: 8, y: 650, width: 87, height: 57 },
        ...(ballEnabled ? {} : { enabled: false }),
        children: [
          {
            type: 'StaticText',
            id: 'scoring-control-label',
            text: 'BALL',
            bounds: { x: 9, y: 674, width: 85, height: 13 }
          }
        ]
      }
    ]
  }
  return tree
}

describe('tapping a pitch on the mobile scoring rig', function () {
  it("taps the Ball button, never Undo's row repeating the peer's Ball", function () {
    const tree = deck()
    // A text match finds Undo's own words first.
    const flat = (node: Node): Node[] => [
      node,
      ...(node.children ?? []).flatMap(flat)
    ]
    expect(
      flat(tree)
        .filter(node => labelOf(node) === 'Ball')
        .map(node => node.type)
    ).deep.equals(['StaticText', 'Button'])
    expect(buttonPoint(tree, 'Ball')).equals('52,679')
  })

  it('waits while the Ball button is disabled', function () {
    expect(buttonPoint(deck(false), 'Ball')).equals(undefined)
  })
})

describe('signing out a relaunched app on the mobile scoring rig', function () {
  const noMenu = new Error(
    'assertVisible: text="Notifications": Element not visible: text=\'Notifications\''
  )
  const device = null as unknown as Parameters<typeof signOutAfterLaunch>[0]

  it('signs out again when the first tap on the account opened no menu', async function () {
    let calls = 0
    await signOutAfterLaunch(
      device,
      async () => {
        calls++
        if (calls === 1) throw noMenu
      },
      0
    )
    expect(calls).equals(2)
  })

  it('gives up after the second try, and never retries another failure', async function () {
    let calls = 0
    const failing = async (): Promise<void> => {
      calls++
      throw noMenu
    }
    await signOutAfterLaunch(device, failing, 0).then(
      () => expect.fail('signed out'),
      (error: unknown) => expect(error).equals(noMenu)
    )
    expect(calls).equals(2)
    calls = 0
    const other = new Error('no Sign out on the account page')
    await signOutAfterLaunch(
      device,
      async () => {
        calls++
        throw other
      },
      0
    ).then(
      () => expect.fail('signed out'),
      (error: unknown) => expect(error).equals(other)
    )
    expect(calls).equals(1)
  })
})
