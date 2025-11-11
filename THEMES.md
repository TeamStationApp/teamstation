# Using themes and patina

1. Change the app to properly use react-native-patina and themes
2. Note the pattern in gsDark.ts. Colors are only specified in the palette object and all keys are the english name of the color and the values are the hex or string code of the color
3. The theme section has keys that represent where in the app the color is used and the values of the Theme are always the keys from the palette. This helps keep the palette consistent across screens and reuse similar colors.
4. Use EventRegistration.tsx as a template and notice how the theme's backgroundColor: theme.backgroundColor is declared and used.
5. Now change all the screens to use this pattern and move all colors into the gsDark.ts file's palette and remove an unused colors.
6. Then add/remove any Theme parameters as necessary to create the styles necessary for all the screens.
7. Change all screens to use the patina styles pattern by moving all font and color definition to the gsDark file and edit the Theme type as necessary.

