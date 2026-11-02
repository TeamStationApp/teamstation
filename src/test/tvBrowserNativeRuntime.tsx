import React from 'react'
import { Pressable as WebPressable, View } from 'react-native-web'

export {
  Animated,
  Image,
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

/** Model the native wrapper's destination-based selectability for empty pages. */
export function TVFocusGuideView({
  destinations,
  autoFocus,
  ...props
}: any): React.ReactElement {
  return (
    <View
      {...props}
      tabIndex={Boolean(destinations) || Boolean(autoFocus) ? 0 : -1}
    />
  )
}

export const Pressable = React.forwardRef<any, any>((props, ref) => {
  if (props.testID !== undefined) nativeViews.set(props.testID, props)
  return <WebPressable {...props} ref={ref} />
})
export const BackHandler = {
  addEventListener: (event: string, listener: () => boolean) => {
    nativeViews.set(event, listener)
    return {
      remove: () => {
        if (nativeViews.get(event) === listener) nativeViews.delete(event)
      }
    }
  }
}
