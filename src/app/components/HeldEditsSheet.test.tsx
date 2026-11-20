import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { find, mount, press, settle, unmount } from '../../test/gameFormDom'
import type { HeldEdit } from '../sync/useOffline'
import { SERVER_COPY_PENDING } from '../sync/useOffline'
import {
  HELD_EDITS_TITLE,
  type HeldEditActions,
  HeldEditsSheet
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
        discard: async () => true
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
      'A player added on this phone was not saved: Only staff'
    )
    expect(find('Try Again, Owls @ Hawks')).not.equals(undefined)
    expect(find("Use Server's Copy, A team")).not.equals(undefined)
  })

  it('sends one row again, or takes its server copy, and touches no other', async () => {
    const calls: string[] = []
    await draw([game, team], {
      retry: async edit => {
        calls.push(`retry ${edit.id}`)
      },
      discard: async edit => {
        calls.push(`discard ${edit.id}`)
        return true
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
        return false
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
    expect(row('game', 'g1')?.textContent).includes(SERVER_COPY_PENDING)
  })

  it('says what went wrong when a failure is not an error', async () => {
    await draw([game], {
      retry: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope'
      },
      discard: async () => true
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
        return true
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
      discard: async () => true
    })
    await press('Cancel')
    expect(again.closed()).equals(1)
    expect(row('game', 'g1')).equals(null)
    expect(calls).deep.equals([])
  })
})
