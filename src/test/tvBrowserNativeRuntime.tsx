import React from 'react'
import { View } from 'react-native-web'

export {
  BackHandler,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native-web'
const handles = new WeakMap<object, number>()
let nextHandle = 1
export function findNodeHandle(node: object): number {
  if (!handles.has(node)) handles.set(node, nextHandle++)
  return handles.get(node)!
}
export const Platform = { OS: 'ios', isTV: true }
export const nativeViews = new Map<string, any>()
/** Captures bridge props, not UIKit pixels; device tests verify actual layout. */
export function requireNativeComponent(name: string): React.ComponentType<any> {
  return function NativeView(props: any): React.ReactElement {
    nativeViews.set(name, props)
    return (
      <View testID={props.testID ?? name} style={props.style}>
        {props.children}
      </View>
    )
  }
}
