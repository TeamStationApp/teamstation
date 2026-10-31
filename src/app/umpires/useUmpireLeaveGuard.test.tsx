import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  type UmpireLeaveGuard,
  useUmpireLeaveGuard
} from './useUmpireLeaveGuard'

describe('the umpire schedule’s leave guard', function () {
  async function mounted(): Promise<{
    guard: UmpireLeaveGuard
    done: () => Promise<void>
  }> {
    let guard: UmpireLeaveGuard | undefined
    function Harness(): null {
      guard = useUmpireLeaveGuard()
      return null
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Harness />)
    })
    return {
      guard: guard!,
      done: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    }
  }

  it('lets a move go with no check held, and holds one until the check accepts', async function () {
    const { guard, done } = await mounted()
    try {
      const moves: string[] = []
      expect(guard.guard(() => moves.push('free'))).equals(false)
      let decide: ((accepted: boolean) => void) | undefined
      const release = guard.register(
        async () => await new Promise<boolean>(resolve => (decide = resolve))
      )
      expect(guard.guard(() => moves.push('held'))).equals(true)
      expect(guard.pending()).equals(true)
      decide!(true)
      await act(async () => undefined)
      expect(moves).deep.equals(['held'])
      expect(guard.pending()).equals(false)
      release()
      expect(await guard.check()).equals(true)
    } finally {
      await done()
    }
  })

  it('refuses a second move while the check decides, and tells its caller', async function () {
    const { guard, done } = await mounted()
    try {
      const moves: string[] = []
      const refused: string[] = []
      let decide: ((accepted: boolean) => void) | undefined
      guard.register(
        async () => await new Promise<boolean>(resolve => (decide = resolve))
      )
      guard.guard(
        () => moves.push('chevron'),
        () => refused.push('chevron')
      )
      // Android's Back, delivered as a history step while the save decides.
      expect(
        guard.guard(
          () => moves.push('hardware'),
          () => refused.push('hardware')
        )
      ).equals(true)
      expect(refused).deep.equals(['hardware'])
      decide!(true)
      await act(async () => undefined)
      expect(moves).deep.equals(['chevron'])
      expect(refused).deep.equals(['hardware'])
    } finally {
      await done()
    }
  })

  it('refuses the move when the check declines, fails, or is let go meanwhile', async function () {
    const { guard, done } = await mounted()
    try {
      const refused: string[] = []
      guard.register(async () => false)
      guard.guard(
        () => undefined,
        () => refused.push('declined')
      )
      await act(async () => undefined)
      guard.register(async () => {
        throw new Error('Save refused')
      })
      guard.guard(
        () => undefined,
        () => refused.push('failed')
      )
      await act(async () => undefined)
      let decide: ((accepted: boolean) => void) | undefined
      const release = guard.register(
        async () => await new Promise<boolean>(resolve => (decide = resolve))
      )
      guard.guard(
        () => undefined,
        () => refused.push('let go')
      )
      release()
      decide!(true)
      await act(async () => undefined)
      expect(refused).deep.equals(['declined', 'failed', 'let go'])
    } finally {
      await done()
    }
  })
})
