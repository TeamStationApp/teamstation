package app.teamstation.streamcore.capture

import android.graphics.Rect
import app.teamstation.streamcore.core.FocusPoint
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MeteringRegionTest {
    @Test fun aNonzeroPixelArrayOriginDoesNotShiftOrOverflowTheFocusRegion() {
        val offset = Rect(32, 24, 4064, 3048)
        val zero = Rect(0, 0, offset.width(), offset.height())
        for (point in listOf(FocusPoint.create(.2, .8)!!, FocusPoint.create(0.0, 0.0)!!, FocusPoint.create(1.0, 1.0)!!)) {
            val region = focusMeteringRegion(point, 1440, 1080, offset)!!.rect
            assertEquals(focusMeteringRegion(point, 1440, 1080, zero)!!.rect, region)
            assertTrue(region.left >= 0 && region.top >= 0)
            assertTrue(region.right < offset.width() && region.bottom < offset.height())
        }
        assertNull(focusMeteringRegion(FocusPoint.create(.5, .5)!!, 0, 1080, offset))
        assertNull(focusMeteringRegion(FocusPoint.create(.5, .5)!!, 1440, 1080, Rect(0, 0, 1, 1)))
    }
}
