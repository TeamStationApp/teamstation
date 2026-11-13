import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatSocketEvent } from '../../common/gameSocket'
import { DeviceApprovals } from './deviceApprovals'
import type { ChatSetup } from './engine/links'

/** Which socket hints make the approval queue read its links again. */
describe('device approvals on a socket hint', function () {
  it('reads again for a device or link change, never for mutes or notification switches', async function () {
    let listener: ((event: ChatSocketEvent) => void) | undefined
    const controller = new DeviceApprovals({} as unknown as ChatSetup, {
      onChat: next => {
        listener = next
        return () => {
          listener = undefined
        }
      }
    })
    let reads = 0
    controller.refresh = async () => {
      reads++
    }
    controller.start()
    try {
      expect(reads).equals(1)
      listener!({ type: 'chatUser', kind: 'notifications' })
      listener!({ type: 'chatUser', kind: 'preferences' })
      expect(reads).equals(1)
      listener!({ type: 'chatUser', kind: 'link' })
      listener!({ type: 'chatUser', kind: 'devices' })
      listener!({ type: 'resync' })
      expect(reads).equals(4)
    } finally {
      controller.stop()
    }
    expect(listener).equals(undefined)
  })
})
