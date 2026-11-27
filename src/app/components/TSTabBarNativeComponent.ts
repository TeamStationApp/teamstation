import type {
  CodegenTypes,
  ColorValue,
  HostComponent,
  ViewProps
} from 'react-native'
import { codegenNativeComponent } from 'react-native'

export type NativeTab = Readonly<{
  id: string
  title: string
  symbol: string
  selectedSymbol: string
  badge: boolean
  testID: string
}>

export interface NativeProps extends ViewProps {
  items: readonly NativeTab[]
  selectedId: string
  compact: boolean
  activeColor: ColorValue
  inactiveColor: ColorValue
  opaqueBackgroundColor?: ColorValue
  badgeColor: ColorValue
  dark: boolean
  onSelectTab: CodegenTypes.DirectEventHandler<Readonly<{ id: string }>>
  onBarHeight: CodegenTypes.DirectEventHandler<
    Readonly<{ height: CodegenTypes.Double }>
  >
}

export default codegenNativeComponent<NativeProps>('TSTabBar', {
  excludedPlatforms: ['android']
}) as HostComponent<NativeProps>
