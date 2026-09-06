package co.gamestation.cameraman.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The GameStation palette, expressed as Material 3 colour roles.
 *
 * Seeded from the cream in the app mark (`mobile/icons/generateAppIcons.js` samples the same
 * `#E6E4D5` off the logo), so Cameraman, Director and Watcher read as one family on a bench.
 *
 * **Deliberately not dynamic colour.** `dynamicDarkColorScheme` is the Material 3 default advice and
 * is the wrong call here: a rack of phones on a field would each take their owner's wallpaper and no
 * two cameras would look alike, which is exactly the confusion the per-camera name badge exists to
 * prevent. A broadcast tool wants one identity across every handset it runs on.
 *
 * Dark only, for the same reason the iOS build declares `UIUserInterfaceStyle=Dark`: this is a
 * viewfinder, and a light chrome over live video costs contrast on the picture that matters.
 */
private val Cream = Color(0xFFE6E4D5)
private val CreamDim = Color(0xFFB7B5A8)
private val Ink = Color(0xFF14140F)
private val Charcoal = Color(0xFF1C1C18)
private val Slate = Color(0xFF2A2A25)
private val Live = Color(0xFF7ED08A)
private val Warn = Color(0xFFE0A44B)
private val Danger = Color(0xFFE0685B)

private val CameramanColors = darkColorScheme(
    primary = Cream,
    onPrimary = Ink,
    primaryContainer = Slate,
    onPrimaryContainer = Cream,

    secondary = CreamDim,
    onSecondary = Ink,
    secondaryContainer = Charcoal,
    onSecondaryContainer = Cream,

    tertiary = Live,
    onTertiary = Ink,
    tertiaryContainer = Color(0xFF23412A),
    onTertiaryContainer = Live,

    error = Danger,
    onError = Ink,
    errorContainer = Color(0xFF44201C),
    onErrorContainer = Danger,

    // Near-black rather than pure black: the preview is full-bleed behind the chrome, and a pure
    // black surface makes every panel edge disappear into the picture.
    background = Color(0xFF0D0D0B),
    onBackground = Cream,
    surface = Charcoal,
    onSurface = Cream,
    surfaceVariant = Slate,
    onSurfaceVariant = CreamDim,
    surfaceContainerLowest = Color(0xFF0A0A08),
    surfaceContainerLow = Color(0xFF161612),
    surfaceContainer = Charcoal,
    surfaceContainerHigh = Slate,
    surfaceContainerHighest = Color(0xFF35352E),

    outline = Color(0xFF605E54),
    outlineVariant = Color(0xFF3A3A33),
    // The scrim is what the chrome over live video sits on, so it is a real role here rather than an
    // afterthought — every badge and button on the camera screen reads against moving pictures.
    scrim = Color(0xFF000000)
)

/**
 * The technical values — the RTSP address, the camera's identifier, the zoom readout — are monospace
 * on purpose. They are read character by character off a phone on a tripod, often against a second
 * device showing the same string, and a proportional font makes that comparison slower.
 */
val MonospaceLabel = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontWeight = FontWeight.Medium,
    fontSize = 12.sp,
    letterSpacing = 0.sp
)

/**
 * A compact type scale.
 *
 * Material 3's default scale is drawn for a phone held in portrait. This app is landscape-only, so
 * its window is 411dp *tall* on a Pixel 10, and the stock scale overflowed the settings screen badly
 * enough that the microphone toggle and the camera's identifier were both off the bottom — the exact
 * failure the two-column layout exists to prevent.
 *
 * Shrinking here rather than at each call site is the point of having a theme: one scale, applied
 * everywhere, instead of a hand-picked `fontSize` on every `Text` that would drift apart the first
 * time someone added a row.
 */
private val default = Typography()

private val CameramanTypography = Typography(
    titleLarge = default.titleLarge.copy(fontSize = 18.sp, lineHeight = 22.sp),
    titleMedium = default.titleMedium.copy(fontSize = 15.sp, lineHeight = 19.sp),
    bodyLarge = default.bodyLarge.copy(fontSize = 14.sp, lineHeight = 18.sp),
    bodyMedium = default.bodyMedium.copy(fontSize = 13.sp, lineHeight = 17.sp),
    bodySmall = default.bodySmall.copy(fontSize = 11.sp, lineHeight = 14.sp),
    labelLarge = default.labelLarge.copy(fontSize = 13.sp, lineHeight = 17.sp),
    labelMedium = default.labelMedium.copy(fontSize = 11.sp),
    labelSmall = default.labelSmall.copy(fontSize = 10.sp, letterSpacing = 0.8.sp)
)

@Composable
fun CameramanTheme(content: @Composable () -> Unit) {
    // `isSystemInDarkTheme` is read and ignored on purpose: the answer is always the dark scheme.
    // Reading it keeps the call site honest about the fact that this is a choice rather than an
    // oversight.
    @Suppress("UNUSED_VARIABLE")
    val systemPrefersDark = isSystemInDarkTheme()

    MaterialTheme(
        colorScheme = CameramanColors,
        typography = CameramanTypography,
        content = content
    )
}

object CameramanTokens {
    /** The alpha a scrim needs to hold Material 3's contrast targets over live video. */
    const val chromeScrimAlpha = 0.55f

    /** A lighter scrim for surfaces that sit over video but carry no text of their own. */
    const val subtleScrimAlpha = 0.35f

    /**
     * The one margin every piece of chrome uses.
     *
     * Top, left, right and bottom of the overlay, and the gap between the badges and the zoom rail
     * below them. A single value rather than a number per edge because the chrome is four islands
     * floating on live video with nothing to align to but the screen, and an operator reads
     * inconsistent gaps as a layout that is broken rather than as one that is deliberate.
     */
    val chromeMargin = 28.dp

    /** The size of a round chrome button. */
    val chromeButtonSize = 52.dp

    /**
     * The height every chrome pill shares — the camera name, the thermal badge, the battery badge.
     *
     * Fixed rather than derived from each one's text, so the badges on the right sit on exactly the
     * line the name does on the left. Two pills that differ by three points read as a mistake even
     * when nobody can say which one is wrong.
     */
    val chromePillHeight = 36.dp

    /**
     * How far the badge row sits below the top margin.
     *
     * The buttons opposite are taller than the pills beside them and centre their row, so a pill on
     * the right has to drop by half that difference to land on the same line. Expressed as the
     * offset rather than by padding the whole row out to the button height, so the gap from the
     * badges down to the zoom rail stays exactly [chromeMargin] instead of that plus the leftover.
     */
    val badgeTopOffset = (chromeButtonSize - chromePillHeight) / 2
}
