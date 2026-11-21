import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { find, mount, press, settle, unmount } from '../../test/gameFormDom'
import {
  HELD_GAME_CONSEQUENCE,
  HELD_TEAM_CONSEQUENCE
} from '../scoring/HeldGameNotice'
import type { HeldEdit } from '../sync/useOffline'
import { SERVER_COPY_PENDING } from '../sync/useOffline'
import {
  HELD_EDITS_TITLE,
  HELD_SENDING,
  type HeldEditActions,
  HeldEditsSheet,
  TEAM_COPY_PENDING
} from './HeldEditsSheet'

const game: HeldEdit = {
  kind: 'game',
  id: 'g1',
  held: { state: 'dead', message: 'That inning is closed.' }
}
const team: HeldEdit = {
  kind: 'team',
  id: 't1',
  held: { state: 'dead', message: 'Only staff' }
}

const row = (kind: string, id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="heldEdit-${kind}-${id}"]`)

/** Draws the sheet with `edits`, and lets the test change them. */
async function draw(
  edits: HeldEdit[],
  actions: HeldEditActions,
  names: Record<string, string> = {}
): Promise<{ closed: () => number; set: (next: HeldEdit[]) => void }> {
  let closed = 0
  let set: (next: HeldEdit[]) => void = () => undefined
  const Host = (): React.ReactElement | null => {
    const [shown, setShown] = React.useState(edits)
    const [open, setOpen] = React.useState(true)
    set = setShown
    return open ? (
      <HeldEditsSheet
        edits={shown}
        names={names}
        actions={actions}
        onClose={() => {
          closed++
          setOpen(false)
        }}
      />
    ) : null
  }
  await mount(<Host />)
  return {
    closed: () => closed,
    set: next => {
      set(next)
    }
  }
}

describe('the list of held edits', () => {
  afterEach(async () => {
    await unmount()
  })

  it('names each held game and team, or stands in for one it cannot name, with what the server said', async () => {
    await draw(
      [game, team],
      {
        retry: async () => undefined,
        discard: async () => 'arrived'
      },
      { 'game:g1': 'Owls @ Hawks' }
    )
    expect(document.body.textContent).includes(HELD_EDITS_TITLE)
    expect(row('game', 'g1')?.textContent).includes('Owls @ Hawks')
    expect(row('game', 'g1')?.textContent).includes(
      'Not sent: That inning is closed.'
    )
    expect(row('team', 't1')?.textContent).includes('A team')
    expect(row('team', 't1')?.textContent).includes(
      'A player added in this tab was not saved: Only staff'
    )
    // What taking the server's copy costs, said before it is pressed.
    expect(row('game', 'g1')?.textContent).includes(HELD_GAME_CONSEQUENCE)
    expect(row('team', 't1')?.textContent).includes(HELD_TEAM_CONSEQUENCE)
    expect(find('Try Again, Owls @ Hawks')).not.equals(undefined)
    expect(find("Use Server's Copy, A team")).not.equals(undefined)
  })

  it('offers a parked team no Try Again, and every game and refused team one, as their own notices did', async () => {
    const parkedTeam: HeldEdit = {
      kind: 'team',
      id: 't2',
      held: { state: 'parked', message: null, cause: 'player' }
    }
    const parkedGame: HeldEdit = {
      kind: 'game',
      id: 'g2',
      held: { state: 'parked', message: 'stale' }
    }
    await draw([game, parkedGame, team, parkedTeam], {
      retry: async () => undefined,
      discard: async () => 'arrived'
    })
    expect(find('Try Again, A team')).not.equals(undefined)
    const tries = (kind: string, id: string): number =>
      [...(row(kind, id)?.querySelectorAll('[role="button"]') ?? [])].filter(
        node => (node.getAttribute('aria-label') ?? '').startsWith('Try Again')
      ).length
    expect(tries('game', 'g1')).equals(1)
    expect(tries('game', 'g2')).equals(1)
    expect(tries('team', 't1')).equals(1)
    expect(tries('team', 't2')).equals(0)
    expect(
      row('team', 't2')?.querySelector('[aria-label^="Use Server"]')
    ).not.equals(null)
  })

  it('sends one row again, or takes its server copy, and touches no other', async () => {
    const calls: string[] = []
    await draw([game, team], {
      retry: async edit => {
        calls.push(`retry ${edit.id}`)
      },
      discard: async edit => {
        calls.push(`discard ${edit.id}`)
        return 'arrived'
      }
    })
    await press('Try Again, A game')
    await press("Use Server's Copy, A team")
    expect(calls).deep.equals(['retry g1', 'discard t1'])
  })

  it('holds both of a row’s buttons while one runs, and says why one did not go through', async () => {
    let release: () => void = () => undefined
    const calls: string[] = []
    await draw([game], {
      retry: async () => {
        calls.push('retry')
        await new Promise<void>(resolve => {
          release = resolve
        })
        throw new Error('No signal. Retry.')
      },
      discard: async () => {
        calls.push('discard')
        return 'inflight'
      }
    })
    await press('Try Again, A game')
    expect(
      find("Use Server's Copy, A game")?.getAttribute('aria-disabled')
    ).equals('true')
    await press("Use Server's Copy, A game")
    expect(calls).deep.equals(['retry'])
    await act(async () => {
      release()
    })
    await settle(0)
    expect(row('game', 'g1')?.textContent).includes('No signal. Retry.')
    await press("Use Server's Copy, A game")
    await settle(0)
    expect(calls).deep.equals(['retry', 'discard'])
    // Still listed: part of it was on its way, and nothing was dropped.
    expect(row('game', 'g1')?.textContent).includes(HELD_SENDING)
  })

  it('says, once a row has gone, that the server’s copy did not come back, in a game’s or a team’s words', async () => {
    const drawn: {
      sheet?: { closed: () => number; set: (next: HeldEdit[]) => void }
    } = {}
    // The queue answers that the copy did not come back before the summary
    // that drops the hold reaches the sheet, and after it, for the team.
    const discard = async (edit: HeldEdit): Promise<'pending'> => {
      if (edit.kind === 'team')
        await act(async () => {
          drawn.sheet!.set([])
        })
      return 'pending'
    }
    const sheet = await draw([game, team], {
      retry: async () => undefined,
      discard
    })
    drawn.sheet = sheet
    await press("Use Server's Copy, A game")
    await settle(0)
    // The row is still drawn, and says nothing of being sent: what it came
    // to is the outbox's answer, not whether the row has gone yet.
    expect(row('game', 'g1')?.textContent).not.includes(HELD_SENDING)
    await act(async () => {
      sheet.set([team])
    })
    expect(row('game', 'g1')).equals(null)
    await press("Use Server's Copy, A team")
    await settle(0)
    const said = [
      ...document.querySelectorAll('[data-testid="heldEditGone"]')
    ].map(node => node.textContent)
    expect(said).deep.equals([
      `A game: ${SERVER_COPY_PENDING}`,
      `A team: ${TEAM_COPY_PENDING}`
    ])
    // Nothing held, and the sheet stays to say so until it is closed.
    expect(sheet.closed()).equals(0)
    await press('Cancel')
    expect(sheet.closed()).equals(1)
  })

  it('says what went wrong when a failure is not an error', async () => {
    await draw([game], {
      retry: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope'
      },
      discard: async () => 'arrived'
    })
    await press('Try Again, A game')
    await settle(0)
    expect(row('game', 'g1')?.textContent).includes('That did not work. Retry.')
  })

  it('drops a row whose hold is gone, closes once none is left, and Cancel changes nothing', async () => {
    const calls: string[] = []
    const sheet = await draw([game, team], {
      retry: async () => {
        calls.push('retry')
      },
      discard: async () => {
        calls.push('discard')
        return 'arrived'
      }
    })
    await act(async () => {
      sheet.set([team])
    })
    expect(row('game', 'g1')).equals(null)
    expect(row('team', 't1')).not.equals(null)
    await act(async () => {
      sheet.set([])
    })
    expect(row('team', 't1')).equals(null)
    expect(sheet.closed()).equals(1)
    await unmount()
    const again = await draw([game], {
      retry: async () => {
        calls.push('retry')
      },
      discard: async () => 'arrived'
    })
    await press('Cancel')
    expect(again.closed()).equals(1)
    expect(row('game', 'g1')).equals(null)
    expect(calls).deep.equals([])
  })
})
