package co.gamestation.cameraman.core

/**
 * Which of the discovered lenses the operator has left on, and what that implies for capture.
 *
 * Disabled IDs rather than enabled ones, so a lens that appears for the first time — a new handset,
 * a firmware update that exposes another physical camera — is on until someone turns it off. The
 * empty set is "use everything", which is the behaviour before this setting existed.
 *
 * **How a disabled lens is actually honoured differs from iOS, and it has to.** There, a selection
 * picks a different `AVCaptureDevice`: drop the ultra-wide and the app opens Dual Wide instead of
 * Triple. Android has no such family of virtual devices, and on a Pixel the physical cameras are not
 * in `cameraIdList` at all, so they cannot be opened on their own. What is available is the logical
 * camera's zoom range, and the lens a logical camera uses is a function of exactly that. So a
 * disabled lens becomes a clamp: turn off the ultra-wide and the range starts at 1x, turn off the
 * telephoto and it stops below its switchover. The operator gets what they asked for — that lens is
 * never selected — by the only mechanism the platform offers.
 */
data class LensSelection(val disabledIDs: Set<String> = emptySet()) {

    fun isEnabled(lens: CameraLens): Boolean = !disabledIDs.contains(lens.id)

    fun enabled(catalog: List<CameraLens>): List<CameraLens> = catalog.filter { isEnabled(it) }

    /** Turning off the last remaining lens would leave capture with nothing to open. */
    fun canDisable(lens: CameraLens, catalog: List<CameraLens>): Boolean =
        catalog.any { it.id != lens.id && it.position == lens.position && isEnabled(it) }

    fun toggling(lens: CameraLens, enabled: Boolean, catalog: List<CameraLens>): LensSelection {
        val ids = disabledIDs.toMutableSet()
        if (enabled) {
            ids.remove(lens.id)
        } else {
            if (!canDisable(lens, catalog)) return this
            ids.add(lens.id)
        }
        return LensSelection(ids)
    }

    fun hasEnabledLens(position: CameraPosition, catalog: List<CameraLens>): Boolean =
        catalog.any { it.position == position && isEnabled(it) }

    /**
     * The zoom range to allow, given what is switched on.
     *
     * The bounds are the enabled lenses' own switchover ratios: the lowest enabled lens sets the
     * floor, and the ceiling is whatever the next *disabled* lens above the highest enabled one
     * hands over at — just under it, so the logical camera never crosses into a lens the operator
     * turned off. With everything on, both ends are null and the hardware range stands.
     *
     * Returns null when nothing at this position is enabled, which the caller reads as "leave the
     * camera alone" rather than "open nothing".
     */
    fun zoomBounds(position: CameraPosition, catalog: List<CameraLens>): ZoomBounds? {
        val atPosition = catalog.filter { it.position == position }.sortedBy { it.displayedZoom }
        if (atPosition.isEmpty()) return ZoomBounds(null, null)
        val on = atPosition.filter { isEnabled(it) }
        if (on.isEmpty()) return null
        if (on.size == atPosition.size) return ZoomBounds(null, null)

        val lowest = on.first()
        val highest = on.last()
        // The first lens above the highest enabled one, if it is off, is the ceiling: stop just
        // short of where the hardware would hand over to it.
        val nextAbove = atPosition.firstOrNull { it.displayedZoom > highest.displayedZoom }
        val ceiling = nextAbove?.takeIf { !isEnabled(it) }?.displayedZoom

        return ZoomBounds(
            minimumDisplayedZoom = if (lowest.id == atPosition.first().id) null else lowest.displayedZoom,
            maximumDisplayedZoom = ceiling?.let { it - ceilingMargin }
        )
    }

    /**
     * How far below a disabled lens's switchover the ceiling sits.
     *
     * A logical camera hands over *at* the switchover, so a ceiling exactly on it would sometimes
     * land on the lens that was turned off. One hundredth of a stop is below anything an operator
     * can see and comfortably clear of the boundary.
     */
    private val ceilingMargin: Double get() = 0.01

    data class ZoomBounds(
        val minimumDisplayedZoom: Double?,
        val maximumDisplayedZoom: Double?
    )
}
