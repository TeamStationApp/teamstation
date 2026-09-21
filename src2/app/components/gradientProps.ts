import type { StyleProp, ViewStyle } from 'react-native'

/**
 * The scrim's props, shared by both `Gradient` files.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin — Metro resolves the import back to the sibling itself.
 */
export interface GradientProps {
  /** Where it goes and how big it is. The fade itself is not configurable. */
  style?: StyleProp<ViewStyle>
}
