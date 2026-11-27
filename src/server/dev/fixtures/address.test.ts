import { expect } from 'chai'
import { describe, it } from 'mocha'

import { DUMP_MAILBOX } from '../../../../e2e/core/dumps'
import { DUMP_WORLD_MAILBOX } from './address'
import { refuseRealAddresses } from './baseline'

/** A database whose user_emails table holds `emails`. */
function holding(emails: string[]): any {
  return {
    selectFrom: (table: string) => {
      expect(table).equals('user_emails')
      return {
        select: () => ({
          execute: async () => emails.map(email => ({ email }))
        })
      }
    }
  }
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('the addresses fixtures accept', function () {
  const dumped = 'dumps+coach-game-coach-1@example.test'

  it('names the mailbox the committed dump worlds were made on', function () {
    expect(DUMP_WORLD_MAILBOX).equals(DUMP_MAILBOX)
  })

  it('seeds beside a restored dump world when the dump mailbox is allowed too', async function () {
    const emails = ['e2e+world-coach-1@example.test', dumped]
    expect(
      await refuseRealAddresses(holding(emails), 'e2e@example.test', [
        DUMP_WORLD_MAILBOX
      ])
    ).deep.equals(emails)
  })

  it('still refuses another mailbox’s addresses unless they are allowed, and any real one', async function () {
    expect(
      await refusal(
        async () =>
          await refuseRealAddresses(holding([dumped]), 'e2e@example.test')
      )
    ).equals(
      'fixtures refuse this database: 1 address(es) are not test addresses'
    )
    expect(
      await refusal(
        async () =>
          await refuseRealAddresses(
            holding(['e2e+a@example.test', 'pat@example.com']),
            'e2e@example.test',
            [DUMP_WORLD_MAILBOX]
          )
      )
    ).equals(
      'fixtures refuse this database: 1 address(es) are not test addresses'
    )
  })
})
