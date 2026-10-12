import { expect } from 'chai'
import { describe, it } from 'mocha'

import { screenOf } from './screenOf'

describe('the e2e screen size', function () {
  it('takes the root’s bounds when it has them, as on iOS', function () {
    expect(
      screenOf({ bounds: { x: 0, y: 0, width: 844, height: 390 } })
    ).deep.equals({ x: 0, y: 0, width: 844, height: 390 })
  })

  it('takes the largest element when the root has none, as on Android', function () {
    expect(
      screenOf({
        children: [
          {
            bounds: { x: 0, y: 0, width: 2424, height: 1080 },
            children: [{ bounds: { x: 10, y: 10, width: 100, height: 40 } }]
          },
          { bounds: { x: 0, y: 0, width: 0, height: 0 } }
        ]
      })
    ).deep.equals({ x: 0, y: 0, width: 2424, height: 1080 })
  })

  it('says so when nothing has a size', function () {
    expect(() => screenOf({ children: [{}] })).to.throw(
      'no element with a size'
    )
  })
})
