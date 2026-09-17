import { expect } from 'chai'
import { describe, it } from 'mocha'

import { enUs } from './en_US'
import { lstrings, plural, selectLocale, sprintf } from './strings'

describe('locales', function () {
  it('starts out as the English master', function () {
    selectLocale(undefined)
    expect(lstrings.login_title).equals(enUs.login_title)
    expect(Object.keys(lstrings).length).equals(Object.keys(enUs).length)
  })

  it('has no empty strings to render as a blank screen', function () {
    for (const [key, value] of Object.entries(enUs)) {
      expect(value, `${key} is empty`).does.not.equal('')
    }
  })

  it('merges a translation over the master', function () {
    selectLocale({ login_title: 'Iniciar sesión' })
    expect(lstrings.login_title).equals('Iniciar sesión')
    // Anything untranslated stays readable rather than showing a key.
    expect(lstrings.login_email).equals(enUs.login_email)
    selectLocale(undefined)
    expect(lstrings.login_title).equals(enUs.login_title)
  })

  it('ignores keys the master does not have', function () {
    selectLocale({ not_a_real_key: 'nonsense' })
    expect((lstrings as Record<string, string>).not_a_real_key).equals(
      undefined
    )
    selectLocale(undefined)
  })

  it('ignores an empty translation rather than blanking the screen', function () {
    selectLocale({ login_title: '' })
    expect(lstrings.login_title).equals(enUs.login_title)
    selectLocale(undefined)
  })

  it('fills placeholders in order', function () {
    expect(sprintf('%s videos', 3)).equals('3 videos')
    expect(sprintf('%s of %s', 1, 2)).equals('1 of 2')
    expect(sprintf('%s', null)).equals('')
  })

  it('chooses the singular or the plural', function () {
    const one = enUs.games_video_count_one
    const other = enUs.games_video_count_other
    expect(plural(1, one, other)).equals('1 video')
    expect(plural(3, one, other)).equals('3 videos')
    expect(plural(0, one, other)).equals('0 videos')
  })
})
