import { expect } from 'chai'
import { describe, it } from 'mocha'

import { enUs } from './en_US'
import {
  lstrings,
  plural,
  selectLocale,
  sprintf,
  videoCountLabel
} from './strings'

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

  it('drops the strings of the chat list action and members screen it no longer has', function () {
    expect(enUs).not.to.have.any.keys('chat_follow_team', 'chat_members_title')
  })

  it('names the umpire schedule’s Division column, sorts and Save sort', function () {
    expect(enUs.umpire_division).equals('Division')
    expect(
      sprintf(enUs.umpire_sort_by_named, 'Date', enUs.umpire_sort_oldest)
    ).equals('Sort by Date, oldest to newest')
    expect(
      sprintf(enUs.umpire_sort_then_named, 'Season', enUs.umpire_sort_a_z)
    ).equals('Then by Season, A to Z')
    expect(enUs.umpire_sort_add_named).equals('Add a second sort')
    expect(enUs.umpire_sort_remove).equals('Remove sort')
    expect([
      enUs.umpire_sort_title_first,
      enUs.umpire_sort_title_second
    ]).deep.equals(['Sort by', 'Then by'])
    expect(enUs.umpire_save_sort).equals('Save sort')
    expect(enUs.umpire_save_sort_named).equals(
      'Save this sort as the league default'
    )
  })

  it('names the requirements screen’s season order controls', function () {
    expect([
      enUs.umpire_season_priority_sort,
      enUs.umpire_season_priority_cancel,
      enUs.umpire_season_priority_save
    ]).deep.equals(['Sort', 'Cancel', 'Save'])
    expect(enUs.umpire_season_priority_sort_named).equals('Sort seasons')
    expect(enUs.umpire_season_priority_cancel_named).equals(
      'Cancel sorting seasons'
    )
    expect(enUs.umpire_season_priority_save_named).equals(
      'Save the season order'
    )
    expect(
      sprintf(enUs.umpire_season_priority_drag_named, 'Fall Minors')
    ).equals('Drag Fall Minors')
    expect(
      sprintf(enUs.umpire_season_priority_move_named, 'Fall Minors')
    ).equals('Reorder Fall Minors')
  })

  it('names the three notification switches in Account', function () {
    expect(enUs.account_notifications_messages).equals(
      'Notify for direct messages and mentions'
    )
    expect(enUs.account_notifications_rsvp_events).equals(
      'Notify for RSVPed events'
    )
    expect(enUs.account_notifications_league_management).equals(
      'Notify for league management'
    )
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

  it('fills placeholders named by their place', function () {
    expect(sprintf('%1$s %2$s', 'Season', 'coach')).equals('Season coach')
    expect(sprintf('%2$s, %1$s', 'Season', 'coach')).equals('coach, Season')
    expect(sprintf('%3$s', 'one')).equals('')
  })

  it('chooses the singular or the plural', function () {
    const one = enUs.games_video_count_one
    const other = enUs.games_video_count_other
    expect(plural(1, one, other)).equals('1 video')
    expect(plural(3, one, other)).equals('3 videos')
    expect(plural(0, one, other)).equals('0 videos')
  })
})

describe('how many videos', function () {
  it('says one video, and two videos', function () {
    expect(videoCountLabel(1)).equals('1 video')
    expect(videoCountLabel(2)).equals('2 videos')
    expect(videoCountLabel(12)).equals('12 videos')
  })

  it('says nothing at all for none', function () {
    expect(videoCountLabel(0)).equals('')
    expect(videoCountLabel(-1)).equals('')
  })
})
