import assert from 'node:assert/strict'
import { mock } from 'node:test'

import { expect } from 'chai'
import type { Request, Response } from 'express'
import { afterEach, describe, it } from 'mocha'

import { conflict } from '../../common/errors'
import { withQueryReplies } from '../../test/queryReplies'
import * as previews from '../autoScheduler/previews'
import { schedulePreviewRoutes } from './schedulePreviews'

const actor = { userId: 'admin', scopes: [], isAdmin: true }

describe('device preview HTTP boundary', () => {
  afterEach(() => {
    mock.restoreAll()
  })
  it('returns preparation separately from completion and maps malformed results to bad requests', async () => {
    const prepared = { id: 'preview', input: { seasons: [] } }
    const prepare = mock.method(
      previews,
      'preparePreview',
      async () => prepared
    )
    let failure: Error | undefined
    const complete = mock.method(previews, 'completePreview', async () => {
      if (failure != null) throw failure
      return { id: 'preview', status: 'open' }
    })
    await withQueryReplies([], async db => {
      const router = schedulePreviewRoutes(db)
      let status = 200
      const request = async (
        url: string,
        method: string,
        body: unknown,
        signedIn = true
      ): Promise<unknown> =>
        await new Promise((resolve, reject) => {
          const response = {
            locals: {},
            json: resolve,
            status: (value: number) => {
              status = value
              return response
            }
          }
          router(
            {
              url,
              method,
              body,
              actor: signedIn ? actor : undefined
            } as unknown as Request,
            response as unknown as Response,
            reject
          )
        })
      expect(
        await request('/leagues/league/schedule-previews', 'POST', {
          mode: 'full',
          existing: 'workAround'
        })
      ).deep.equals(prepared)
      expect(status).equals(201)
      expect(prepare.mock.calls[0].arguments[2]).equals('league')
      expect(
        await request('/schedule-previews/preview/result', 'PUT', {
          options: []
        })
      ).deep.equals({ id: 'preview', status: 'open' })
      expect(complete.mock.calls[0].arguments[2]).equals('preview')
      failure = new TypeError('Malformed games')
      await assert.rejects(
        request('/schedule-previews/preview/result', 'PUT', {}),
        { status: 400, message: 'Malformed games' }
      )
      failure = conflict('Changed source')
      await assert.rejects(
        request('/schedule-previews/preview/result', 'PUT', {}),
        { status: 409 }
      )
      await assert.rejects(
        request('/schedule-previews/preview/result', 'PUT', {}, false),
        { status: 401 }
      )
      expect(complete.mock.callCount()).equals(3)
    })
  })
})
