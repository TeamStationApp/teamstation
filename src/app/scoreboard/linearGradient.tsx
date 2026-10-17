/**
 * The board's gradients in a browser: `react-native-web-linear-gradient`, the
 * package 1.0's board was drawn with on the web, so the overlay pages look
 * exactly as they did.
 *
 * A phone has no such package installed, so `linearGradient.native.tsx`
 * draws the same gradients with `react-native-svg`. The board imports this
 * file rather than either package, and each platform's bundle picks its own.
 */
export { default } from 'react-native-web-linear-gradient'
