import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asApiError,
  badRequest,
  errorStatus,
  forbidden,
  HttpError,
  notFound,
  toApiError
} from './errors'

describe('errors', function () {
  it('gives every code an HTTP status', function () {
    for (const [code, status] of Object.entries(errorStatus)) {
      expect(status, `${code} has no status`).is.a('number')
      expect(status, `${code} status ${status}`).is.within(400, 599)
    }
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
