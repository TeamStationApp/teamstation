package app.teamstation.app.stream

import android.content.pm.ServiceInfo
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.phonestream.PhoneCapabilities
import app.teamstation.streamcore.phonestream.PhoneLens
import app.teamstation.streamcore.phonestream.PhoneRadarState
import app.teamstation.streamcore.phonestream.PhoneRecording
import app.teamstation.streamcore.phonestream.PhoneStreamError
import app.teamstation.streamcore.phonestream.PhoneStreamStatus
import app.teamstation.streamcore.phonestream.PhoneUploadProgress
import app.teamstation.streamcore.phonestream.PhoneZoomScale
import app.teamstation.streamcore.radar.RadarConnection
import app.teamstation.streamcore.radar.RadarDeviceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The engine's values in the shapes `NativePhoneStream.ts` describes, and the service's types. */
class PhoneStreamMapsTest {
    @Test
    fun statusLeavesOutWhatIsMissingAndNamesTheError() {
        val idle = PhoneStreamMaps.status(PhoneStreamStatus())
        assertEquals("idle", idle["phase"])
        assertEquals("cool", idle["thermal"])
        assertFalse(idle.containsKey("retryInSeconds"))
        assertFalse(idle.containsKey("batteryPercent"))
        assertFalse(idle.containsKey("error"))
        val retrying = PhoneStreamMaps.status(
            PhoneStreamStatus(phase = "retrying", retryInSeconds = 4.0, batteryPercent = 18, error = PhoneStreamError.STREAM_ENDED)
        )
        assertEquals(4.0, retrying["retryInSeconds"])
        assertEquals(18.0, retrying["batteryPercent"])
        assertEquals("streamEnded", retrying["error"])
    }

    @Test
    fun recordingTimesGoOutInMilliseconds() {
        val recording = PhoneRecording(
            recordingID = 7,
            liveStreamId = "lst_00000000000000000001",
            gameId = "gam_00000000000000000001",
            angleName = "Home Plate",
            startedAt = 1_790_000_000.5,
            endedAt = 1_790_000_060.0,
            parts = 2,
            uploadId = "upl_00000000000000000001"
        )
        val map = PhoneStreamMaps.recording(recording, running = true)
        assertEquals(1_790_000_000_500.0, map["startedAt"])
        assertEquals(1_790_000_060_000.0, map["endedAt"])
        assertEquals(2, map["parts"])
        assertEquals(true, map["uploadRunning"])
        assertFalse(map.containsKey("uploadedAt"))
        assertFalse(map.containsKey("videoId"))
        assertFalse(map.containsKey("uploadProgress"))

        // A running upload's last report goes with its take, for a screen that opens part-way.
        val progress = PhoneUploadProgress(
            "lst_00000000000000000001", PhoneUploadProgress.State.UPLOADING, fraction = 0.52, bytesSent = 52, bytesTotal = 100
        )
        val running = PhoneStreamMaps.recording(recording, running = true, progress = progress)
        assertEquals(PhoneStreamMaps.upload(progress), running["uploadProgress"])
        // One that is not running here has none, whatever was last heard.
        assertFalse(PhoneStreamMaps.recording(recording, running = false, progress = progress).containsKey("uploadProgress"))
    }

    @Test
    fun radarUploadZoomAndLensKeepTheirFields() {
        val radar = PhoneStreamMaps.radar(
            PhoneRadarState(
                enabled = true,
                scanning = false,
                bluetooth = "on",
                devices = listOf(RadarDeviceState("TAG-00000001", RadarConnection.connected, pitchMph = 54, readingAt = 1_790_000_000_000)),
                nearby = listOf("TAG-00000002")
            )
        )
        @Suppress("UNCHECKED_CAST")
        val device = (radar["devices"] as List<Map<String, Any?>>).single()
        assertEquals(mapOf("serial" to "TAG-00000001", "connection" to "connected", "pitchMph" to 54.0, "readingAt" to 1_790_000_000_000.0), device)
        assertEquals(listOf("TAG-00000002"), radar["nearby"])

        val upload = PhoneStreamMaps.upload(
            PhoneUploadProgress("lst_00000000000000000001", PhoneUploadProgress.State.UPLOADING, fraction = 0.5, bytesSent = 5, bytesTotal = 10)
        )
        assertEquals("uploading", upload["state"])
        assertEquals(10.0, upload["bytesTotal"])
        assertFalse(upload.containsKey("videoId"))

        val zoom = PhoneStreamMaps.zoomScale(PhoneZoomScale(listOf(0.5, 1.0), listOf(1.0), null, 0.5, 10.0, 1.0))
        assertFalse(zoom.containsKey("digitalFrom"))
        assertEquals(listOf(0.5, 1.0), zoom["presets"])

        val lens = PhoneStreamMaps.lens(PhoneLens(CameraLens("2", CameraPosition.BACK, "2", 13, 0.5, 0.5), enabled = true, canDisable = true))
        assertEquals("back", lens["position"])
        assertEquals("13 mm", lens["title"])
        assertEquals(13.0, lens["focalLengthMM"])
        assertEquals(
            PhoneStreamMaps.capabilities(PhoneCapabilities(true, "Google Pixel 10", canRecordLocally = true)),
            mapOf("supported" to true, "deviceModel" to "Google Pixel 10", "canRecordLocally" to true)
        )
    }

    @Test
    fun requestNeedsAnAddressAndFallsBackToThisPhonesModel() {
        assertNull(PhoneStreamMaps.request(mapOf("token" to "t"), "Google Pixel 10"))
        val request = PhoneStreamMaps.request(
            mapOf("apiBase" to "https://teamstation.example.test/api/v1", "token" to "t", "deviceId" to "00000000-0000-4000-8000-000000000001", "deviceModel" to ""),
            "Google Pixel 10"
        )!!
        assertEquals("Google Pixel 10", request.deviceModel)
        assertEquals("https://teamstation.example.test", request.serverURL)
    }

    @Test
    fun displayRotationIsInDegrees() {
        assertEquals(listOf(0, 90, 180, 270), (0..3).map(PhoneStreamMaps::rotationDegrees))
    }

    @Test
    fun serviceIsCameraAndMicrophoneWhileRecordingAndDataSyncWhileUploading() {
        val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        assertEquals(camera, PhoneStreamService.serviceTypes(recording = true, uploading = false))
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, PhoneStreamService.serviceTypes(recording = false, uploading = true))
        assertEquals(camera or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, PhoneStreamService.serviceTypes(recording = true, uploading = true))
        assertEquals(0, PhoneStreamService.serviceTypes(recording = false, uploading = false))
        assertEquals("Recording Home Plate", PhoneStreamService.title(PhoneStreamService.State(recording = "Home Plate")))
        assertEquals(
            "Recording Home Plate · uploading First Base",
            PhoneStreamService.title(PhoneStreamService.State("Home Plate", "First Base"))
        )
        assertEquals("Uploading First Base", PhoneStreamService.title(PhoneStreamService.State(uploading = "First Base")))
        assertFalse(PhoneStreamService.State().active)
    }
}
