import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asApiError,
  badRequest,
  errorStatus,
  forbidden,
  HttpError,
  membersOnly,
  notFound,
  toApiError
} from './errors'

describe('errors', function () {
  /**
   * Every code a *server* can answer with is a real failure status. `offline`
   * is the exception and deliberately so: it is raised on the device when a
   * request never left it, so there is no response and no status to report. It
   * travels as an error code anyway, so that a caller has one shape to branch
   * on instead of a status number in some cases and a bare TypeError in others.
   */
  it('gives every code a server can send an HTTP status', function () {
    for (const [code, status] of Object.entries(errorStatus)) {
      expect(status, `${code} has no status`).is.a('number')
      if (code === 'offline') {
        expect(status, 'offline is not a response').equals(0)
        continue
      }
      expect(status, `${code} status ${status}`).is.within(400, 599)
    }
  })

  it('reports offline as its own thing, not as a server failure', function () {
    const error = new HttpError('offline', 'Cannot reach TeamStation.')
    expect(error.status).equals(0)
    expect(toApiError(error).code).equals('offline')
  })

  it('round-trips through the cleaner', function () {
    const error = badRequest('Missing teamId', { field: 'teamId' })
    const api = asApiError(error.toApiError())
    expect(api.code).equals('badRequest')
    expect(api.message).equals('Missing teamId')
    expect(api.details).deep.equals({ field: 'teamId' })
  })

  it('omits details when there are none', function () {
    expect(notFound().toApiError()).deep.equals({
      code: 'notFound',
      message: 'Not found'
    })
  })

  it('hides a forbidden resource behind the not-found wording', function () {
    expect(forbidden().message).equals(notFound().message)
  })

  it('tells a non-member a part is for members, with a 403', function () {
    const error = membersOnly()
    expect(error.status).equals(403)
    expect(errorStatus.membersOnly).equals(403)
    expect(asApiError(error.toApiError())).deep.equals({
      code: 'membersOnly',
      message: 'You need to be a member of one of the teams to see this.',
      details: undefined
    })
  })

  it('carries the right status', function () {
    expect(new HttpError('conflict', 'Already there').status).equals(409)
    expect(badRequest('nope').status).equals(400)
  })

  it('never leaks an unexpected error to the caller', function () {
    const leaky = new Error('connection string postgres://user:hunter2@host')
    expect(toApiError(leaky)).deep.equals({
      code: 'internal',
      message: 'Something went wrong'
    })
  })

  it('passes an HttpError through unchanged', function () {
    expect(toApiError(badRequest('Bad id'))).deep.equals({
      code: 'badRequest',
      message: 'Bad id'
    })
  })
})
