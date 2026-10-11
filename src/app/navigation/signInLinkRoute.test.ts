import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  linkDeviceNameFor,
  signInRequestFor
} from '../platform/signInRequestFor'
import { parseRoute, routePath } from './routes'

describe('the sign-in link route', function () {
  it('round-trips the issuing server through its path', function () {
    const route = parseRoute(
      '/signin/T',
      'server=https%3A%2F%2Fseat.example.test'
    )
    expect(route).deep.equals({
      name: 'signInLink',
      token: 'T',
      server: 'https://seat.example.test'
    })
    expect(routePath(route)).equals(
      '/signin/T?server=https%3A%2F%2Fseat.example.test'
    )
    expect(parseRoute('/signin/T', 'server=')).deep.equals({
      name: 'signInLink',
      token: 'T'
    })
    expect(routePath({ name: 'signInLink', token: 'T' })).equals('/signin/T')
  })
})

describe('an installed app’s sign-in request', function () {
  it('names the platform, and the link host when the build has one', function () {
    expect(signInRequestFor('ios', 'https://app1.example.test')).deep.equals({
      origin: 'ios',
      appOrigin: 'https://app1.example.test'
    })
    expect(signInRequestFor('android', undefined)).deep.equals({
      origin: 'android'
    })
  })

  it('names the installed app’s link session after its platform', function () {
    expect(linkDeviceNameFor('ios')).equals('TeamStation for iOS')
    expect(linkDeviceNameFor('android')).equals('TeamStation for Android')
  })
})
