import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asAccountEmail,
  asAccountName,
  checkAccountPicture
} from '../../common/accountSettings'
import { selectNativeAccountPhoto } from './accountPhotoNative'

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    throw new Error('Expected rejection')
  } catch (error) {
    return (error as Error).message
  }
}
describe('account photo adapters and validation', () => {
  it('normalizes the iOS JPEG MIME alias before validation and upload', async () => {
    const picture = await selectNativeAccountPhoto(async () => ({
      assets: [{ base64: 'AAAA', type: 'image/jpg', fileSize: 3 }]
    }))
    expect(picture).deep.equals({ base64: 'AAAA', contentType: 'image/jpeg' })
  })
  it('validates names, emails, image types and sizes', () => {
    expect(asAccountName('  Alex  Rivera  ')).equals('Alex Rivera')
    expect(() => asAccountName('')).throws()
    expect(() => asAccountName('a'.repeat(121))).throws()
    expect(asAccountEmail(' A@EXAMPLE.COM ')).equals('a@example.com')
    expect(() => asAccountEmail('invalid')).throws()
    expect(() => {
      checkAccountPicture('text/plain', 10)
    }).throws('Choose a JPEG')
    for (const size of [0, 10 * 1024 * 1024 + 1])
      expect(() => {
        checkAccountPicture('image/png', size)
      }).throws('10 MB')
    checkAccountPicture('image/png', 10)
  })
  it('handles native cancellation, errors and one bounded photo', async () => {
    expect(
      await selectNativeAccountPhoto(async () => ({ didCancel: true }))
    ).equals(null)
    expect(
      await failure(
        async () =>
          await selectNativeAccountPhoto(async () => ({
            errorCode: 'permission'
          }))
      )
    ).includes('could not be opened')
    expect(
      await failure(
        async () => await selectNativeAccountPhoto(async () => ({}))
      )
    ).includes('could not be read')
    const picture = await selectNativeAccountPhoto(async options => {
      expect(options.selectionLimit).equals(1)
      expect(options.maxWidth).equals(1024)
      return { assets: [{ base64: 'AAAA', type: 'image/jpeg', fileSize: 3 }] }
    })
    expect(picture).deep.equals({ base64: 'AAAA', contentType: 'image/jpeg' })
    expect(
      await selectNativeAccountPhoto(async () => ({
        assets: [{ base64: 'AAAA', type: 'image/png' }]
      }))
    ).not.equals(null)
  })
})
