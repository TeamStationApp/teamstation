import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  API_KEY_AREA_LABELS,
  API_KEY_AREAS,
  asApiKey,
  asApiKeyCreate,
  normalizePermissions,
  secretPreview
} from './apiKeys'

describe('API key permissions', function () {
  it('stores each write with its read, once each, in Account order', function () {
    expect(
      normalizePermissions([
        'team:write',
        'account:read',
        'team:read',
        'gameEvents:write'
      ])
    ).deep.equals([
      'account:read',
      'gameEvents:read',
      'gameEvents:write',
      'team:read',
      'team:write'
    ])
    expect(normalizePermissions([])).deep.equals([])
  })

  it('takes a trimmed name of 1 to 80 characters and at least one permission', function () {
    expect(
      asApiKeyCreate({ name: '  Agent ', permissions: ['umpire:write'] })
    ).deep.equals({
      name: 'Agent',
      permissions: ['umpire:read', 'umpire:write']
    })
    for (const body of [
      { name: '', permissions: ['team:read'] },
      { name: ' ', permissions: ['team:read'] },
      { name: 'x'.repeat(81), permissions: ['team:read'] },
      { name: 'Agent', permissions: [] },
      { name: 'Agent', permissions: ['team:admin'] },
      { name: 'Agent', permissions: 'team:read' },
      { name: 7, permissions: ['team:read'] }
    ])
      expect(() => asApiKeyCreate(body), JSON.stringify(body)).to.throw()
  })

  it('reads a key whose secret could not be opened', function () {
    const key = asApiKey({
      id: 'uak_1',
      name: 'Agent',
      secret: null,
      createdAt: '2026-10-28T00:00:00.000Z',
      permissions: ['team:read']
    })
    expect(key.secret).equals(null)
    expect(secretPreview(key.secret)).equals('Cannot be shown')
    expect(secretPreview('tsk_abcdefghijk')).equals('tsk_abcd…')
  })

  it('labels every area, three of them with subtext', function () {
    expect(Object.keys(API_KEY_AREA_LABELS)).deep.equals([...API_KEY_AREAS])
    expect(
      API_KEY_AREAS.filter(area => API_KEY_AREA_LABELS[area].subtext != null)
    ).deep.equals(['account', 'gameEvents', 'schedule'])
  })
})
