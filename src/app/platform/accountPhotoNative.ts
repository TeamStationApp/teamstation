import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import {
  type AccountPicture,
  checkAccountPicture
} from '../../common/accountSettings'

/** Separate from the native module so cancellation and error contracts are tested in Node. */
export async function selectNativeAccountPhoto(
  launch: (options: ImageLibraryOptions) => Promise<ImagePickerResponse>
): Promise<AccountPicture | null> {
  const result = await launch({
    mediaType: 'photo',
    selectionLimit: 1,
    includeBase64: true,
    maxWidth: 1024,
    maxHeight: 1024,
    quality: 0.9
  })
  if (result.didCancel === true) return null
  if (result.errorCode != null)
    throw new Error('The photo library could not be opened. Please try again')
  const asset = result.assets?.[0]
  if (asset?.base64 == null || asset.type == null)
    throw new Error('That picture could not be read')
  // The iOS picker labels JPEG bytes image/jpg; uploads use the standard MIME type.
  const contentType = asset.type === 'image/jpg' ? 'image/jpeg' : asset.type
  checkAccountPicture(
    contentType,
    asset.fileSize ?? (asset.base64.length * 3) / 4
  )
  return { contentType, base64: asset.base64 }
}
