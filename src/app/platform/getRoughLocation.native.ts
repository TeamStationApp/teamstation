import Geolocation from '@react-native-community/geolocation'
import { PermissionsAndroid, Platform } from 'react-native'

import type { RoughLocationResult } from './roughLocation'
import { requestNativeRoughLocation } from './roughLocationNative'

export async function getRoughLocation(): Promise<RoughLocationResult> {
  return await requestNativeRoughLocation(
    Platform.OS,
    Geolocation,
    async () => {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION
      )
      return granted === PermissionsAndroid.RESULTS.GRANTED
    }
  )
}
