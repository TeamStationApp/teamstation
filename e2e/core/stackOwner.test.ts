import { expect } from 'chai'
import { describe, it } from 'mocha'

import { judgeOwner, judgePid, ownerText, thisHost } from './stackOwner'

const running = (pid: number): boolean => pid === 4242

describe('a stack’s owner', function () {
  it('is gone only when it is this machine’s and its process has stopped', function () {
    const host = thisHost()
    expect(host).matches(/^[0-9a-f]{6}$/)
    expect(judgeOwner(ownerText({ host, pid: 4242 }), running)).equals(
      'running'
    )
    expect(judgeOwner(ownerText({ host, pid: 999999 }), running)).equals('gone')
    // Another machine's, on a shared test cluster: not this one's to judge.
    expect(
      judgeOwner(ownerText({ host: 'abcdef', pid: 999999 }), running, '123456')
    ).equals('elsewhere')
  })

  it('is kept, and said to be unreadable, when it cannot be read', function () {
    for (const text of [
      '',
      null,
      undefined,
      'garbage',
      'e2e stack of host 123456 pid 0',
      'e2e stack of host 123456 pid -4',
      'e2e stack of host 123456 pid NaN',
      'e2e stack of pid 4242'
    ]) {
      expect(
        judgeOwner(text, () => false, '123456'),
        String(text)
      ).equals('unreadable')
    }
  })

  it('judges a registry entry’s pid the same way', function () {
    expect(judgePid(4242, running)).equals('running')
    expect(judgePid(999999, running)).equals('gone')
    for (const pid of [0, -1, 1.5, Number.NaN, '4242', undefined]) {
      expect(
        judgePid(pid, () => false),
        String(pid)
      ).equals('unreadable')
    }
  })
})
