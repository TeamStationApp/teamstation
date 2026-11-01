import React from 'react'
import { View } from 'react-native-web'

export { Image, StyleSheet, View } from 'react-native-web'
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
