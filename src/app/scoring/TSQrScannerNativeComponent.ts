import type { CodegenTypes, HostComponent, ViewProps } from 'react-native'
import { codegenNativeComponent } from 'react-native'

// The `TSQrScanner` Fabric component's codegen spec: Share Lineup's camera,
// which reports each QR code it reads. iOS reads codes with
// `AVCaptureMetadataOutput` (ios/TeamStation/QrScanner/
// TSQrScannerComponentView.mm); Android with CameraX and ML Kit
// (android/.../qrscanner/QrScannerView.kt). Each reports `available` or
// `unavailable` on mount, then `ready` or `denied` once active.

export interface NativeProps extends ViewProps {
  /** Whether the camera runs. */
  active: boolean
  onCode: CodegenTypes.DirectEventHandler<Readonly<{ text: string }>>
  onStatus: CodegenTypes.DirectEventHandler<Readonly<{ status: string }>>
}

export default codegenNativeComponent<NativeProps>(
  'TSQrScanner'
) as HostComponent<NativeProps>
