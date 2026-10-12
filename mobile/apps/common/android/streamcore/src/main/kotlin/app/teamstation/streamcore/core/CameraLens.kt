package app.teamstation.streamcore.core

/**
 * One optical camera the handset actually has.
 *
 * IDs and millimetre values are measured from the device, never hardcoded per model. The settings
 * list is this array, one toggle per entry.
 *
 * One field of the iOS type is deliberately absent. `isSecondaryNative` marks a native sensor crop —
 * the 48 mm 2x on a 48 MP wide — read from `secondaryNativeResolutionZoomFactors`, and Camera2
 * publishes no equivalent. Android reports the physical cameras and nothing else, so a Pixel lists
 * three back lenses where a 15 Pro lists four. Inventing a fourth row from a zoom ratio would be a
 * lens that does not exist.
 */
data class CameraLens(
    val id: String,
    val position: CameraPosition,
    /** The physical camera id, which is what Camera2 knows it by. */
    val physicalCameraID: String,
    val focalLengthMM: Int?,
    val displayedZoom: Double,
    val deviceZoom: Double
) {
    /** `13 mm` when the field of view was readable, otherwise the zoom label the operator knows. */
    val title: String
        get() = focalLengthMM?.let { "$it mm" } ?: ZoomMapping.label(displayedZoom)

    val subtitle: String
        get() {
            val side = if (position == CameraPosition.BACK) "Back" else "Front"
            return "$side · ${ZoomMapping.label(displayedZoom)}"
        }

    /** Compact settings row: millimetres plus which camera, so five rows fit a landscape column. */
    val settingsLabel: String
        get() = "$title · ${if (position == CameraPosition.BACK) "Back" else "Front"}"

    val testTag: String
        get() = "settings-lens-${position.rawValue}-${ZoomMapping.label(displayedZoom)}"
}
