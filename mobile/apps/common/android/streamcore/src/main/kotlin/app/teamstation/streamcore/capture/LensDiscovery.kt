package app.teamstation.streamcore.capture

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.LensOptics

/**
 * Reads the handset's cameras into [CameraLens] rows.
 *
 * Nothing here is a model table. Physical constituents, focal lengths and sensor sizes are all asked
 * of `CameraCharacteristics`, so each handset populates the settings list it actually has.
 *
 * Two differences from the iOS build, both forced by what Camera2 publishes:
 *
 * - **No native-crop rows.** `secondaryNativeResolutionZoomFactors` has no counterpart, so a Pixel
 *   lists its three physical back lenses where a 15 Pro lists four. Inventing a fourth from a zoom
 *   ratio would be a lens that does not exist.
 * - **The field of view is computed rather than read.** iOS publishes `videoFieldOfView` directly;
 *   Camera2 gives focal length and physical sensor size, which is the same statement about the
 *   optics one step earlier.
 */
object LensDiscovery {

    fun discover(manager: CameraManager): List<CameraLens> {
        val lenses = ArrayList<CameraLens>()
        for (position in CameraPosition.entries) {
            val id = CameraSession.preferredCameraId(manager, position) ?: continue
            val characteristics = runCatching { manager.getCameraCharacteristics(id) }.getOrNull()
                ?: continue
            lenses.addAll(catalog(manager, characteristics, position))
        }
        return lenses.sortedWith(
            compareBy({ if (it.position == CameraPosition.BACK) 0 else 1 }, { it.displayedZoom })
        )
    }

    fun catalog(
        manager: CameraManager,
        characteristics: CameraCharacteristics,
        position: CameraPosition
    ): List<CameraLens> {
        val mapping = CameraSession.mapping(manager, characteristics)
        val physicalIds = CameraSession.physicalIds(characteristics)

        // A single-lens camera — every front camera on this hardware — is one row at its own minimum.
        if (physicalIds.size < 2) {
            return listOf(
                lens(
                    manager = manager,
                    physicalId = null,
                    characteristics = characteristics,
                    position = position,
                    displayedZoom = mapping.displayedZoom(mapping.minimumDeviceZoom),
                    deviceZoom = mapping.minimumDeviceZoom,
                    fallbackId = "logical-${position.rawValue}"
                )
            )
        }

        // The switchover ratios are already sorted and already derived from these same lenses, so
        // pairing them by focal length keeps one derivation rather than two that can disagree.
        val byFocalLength = physicalIds
            .mapNotNull { id ->
                val physical = runCatching { manager.getCameraCharacteristics(id) }.getOrNull()
                    ?: return@mapNotNull null
                val focal = physical.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                    ?.maxOrNull()?.toDouble() ?: return@mapNotNull null
                Triple(id, physical, focal)
            }
            .sortedBy { it.third }

        val stops = listOf(mapping.minimumDeviceZoom) + mapping.switchOverDeviceZooms
        return byFocalLength.mapIndexed { index, (id, physical, _) ->
            val deviceZoom = stops.getOrElse(index) { mapping.maximumDeviceZoom }
            lens(
                manager = manager,
                physicalId = id,
                characteristics = physical,
                position = position,
                displayedZoom = mapping.displayedZoom(deviceZoom),
                deviceZoom = deviceZoom,
                fallbackId = id
            )
        }
    }

    private fun lens(
        manager: CameraManager,
        physicalId: String?,
        characteristics: CameraCharacteristics,
        position: CameraPosition,
        displayedZoom: Double,
        deviceZoom: Double,
        fallbackId: String
    ): CameraLens {
        val focal = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
            ?.maxOrNull()?.toDouble()
        val sensorWidth = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
            ?.width?.toDouble()
        val millimetres = if (focal != null && sensorWidth != null) {
            LensOptics.horizontalFieldOfViewDegrees(focal, sensorWidth)
                ?.let { LensOptics.equivalentFocalLengthMM(it) }
        } else {
            null
        }

        return CameraLens(
            id = physicalId ?: fallbackId,
            position = position,
            physicalCameraID = physicalId ?: fallbackId,
            focalLengthMM = millimetres,
            displayedZoom = displayedZoom,
            deviceZoom = deviceZoom
        )
    }
}
