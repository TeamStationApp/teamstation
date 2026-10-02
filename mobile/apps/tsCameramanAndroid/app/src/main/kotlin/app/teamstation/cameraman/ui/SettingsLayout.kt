package app.teamstation.cameraman.ui

/**
 * How many columns Settings lays its cards in.
 *
 * Landscape at 600dp or wider keeps the two columns. Portrait, including a
 * tablet held upright, stacks them. The picture itself stays landscape; this
 * only describes the settings sheet.
 */
object SettingsLayout {
    const val twoColumnMinimumWidthDp = 600

    fun columns(widthDp: Int, heightDp: Int): Int =
        if (widthDp > heightDp && widthDp >= twoColumnMinimumWidthDp) 2 else 1
}
