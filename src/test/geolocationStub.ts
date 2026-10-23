/** `@react-native-community/geolocation` in the DOM tests: answers to order. */
export const geolocationControls: {
  answer: { latitude: number; longitude: number } | null
} = { answer: null }

const Geolocation = {
  getCurrentPosition: (
    found: (position: {
      coords: { latitude: number; longitude: number }
    }) => void,
    refused: (error: unknown) => void
  ): void => {
    if (geolocationControls.answer == null) refused(new Error('denied'))
    else found({ coords: geolocationControls.answer })
  }
}
export default Geolocation
