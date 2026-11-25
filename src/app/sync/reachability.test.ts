import { expect } from 'chai'
import { describe, it } from 'mocha'

import { watchReachability } from './reachability'

describe("the web's network watch", function () {
  it('wakes on the window’s online event until it is stopped (2.harness-review.9)', function () {
    let woken = 0
    const stop = watchReachability(() => {
      woken++
    })
    window.dispatchEvent(new window.Event('online'))
    expect(woken).equals(1)
    window.dispatchEvent(new window.Event('offline'))
    expect(woken).equals(1)
    stop()
    window.dispatchEvent(new window.Event('online'))
    expect(woken).equals(1)
  })
})
