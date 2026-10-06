import { launchImageLibrary } from 'react-native-image-picker'

import type { AccountPicture } from '../../common/accountSettings'
import { selectNativeAccountPhoto } from './accountPhotoNative'

export async function pickAccountPhoto(): Promise<AccountPicture | null> {
  return await selectNativeAccountPhoto(launchImageLibrary)
}
