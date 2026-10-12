package app.teamstation.cameraman.radar

import org.junit.Assert.assertEquals
import org.junit.Test

class ForegroundServiceTypesTest {
    @Test
    fun `foreground types add the radar kinds only when the grants are held`() {
        assertEquals(
            setOf(ServiceTypeName.Camera),
            ForegroundServiceTypes.names(microphone = false, radarGranted = false)
        )
        assertEquals(
            setOf(ServiceTypeName.Camera, ServiceTypeName.Microphone),
            ForegroundServiceTypes.names(microphone = true, radarGranted = false)
        )
        assertEquals(
            setOf(
                ServiceTypeName.Camera,
                ServiceTypeName.Microphone,
                ServiceTypeName.ConnectedDevice,
                ServiceTypeName.Location
            ),
            ForegroundServiceTypes.names(microphone = true, radarGranted = true)
        )
    }
}
