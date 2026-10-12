import type { HostComponent, ViewProps } from 'react-native'
import { codegenNativeComponent } from 'react-native'

// The `TSPhoneStreamPreview` Fabric component's codegen spec: the camera
// straight from the capture, without the programme's picture delay. iOS hosts
// the engine's `AVCaptureVideoPreviewLayer`
// (ios/TeamStation/PhoneStream/TSPhoneStreamPreviewComponentView.mm); Android
// a `TextureView` the capture renderer draws into
// (android/.../stream/PhoneStreamPreviewManager.kt).

export interface NativeProps extends ViewProps {
  /** Mirror the picture, as the front camera's preview is. */
  mirrored?: boolean
}

export default codegenNativeComponent<NativeProps>(
  'TSPhoneStreamPreview'
) as HostComponent<NativeProps>
