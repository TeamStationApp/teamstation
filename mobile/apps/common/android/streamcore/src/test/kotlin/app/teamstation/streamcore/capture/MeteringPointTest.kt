package app.teamstation.streamcore.capture

import app.teamstation.streamcore.core.FocusPoint
import org.junit.Assert.*
import org.junit.Test

class MeteringPointTest {
    @Test fun bufferAspectRatherThanEncoderAspectDeterminesSensorCrop() {
        val point = FocusPoint.create(.2, .8)!!
        assertEquals(point, meteringPoint(point, 1440, 1080, 4000, 3000))
        assertEquals(point, meteringPoint(point, 1080, 1440, 4000, 3000))
        val cropped = meteringPoint(point, 1920, 1080, 4000, 3000)!!
        assertEquals(.2, cropped.x, .00001)
        assertEquals(.725, cropped.y, .00001)
        assertNull(meteringPoint(point, 0, 1080, 4000, 3000))
    }
}
