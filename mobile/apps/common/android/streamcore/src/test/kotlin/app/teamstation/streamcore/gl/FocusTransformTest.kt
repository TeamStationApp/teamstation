package app.teamstation.streamcore.gl

import android.opengl.Matrix
import app.teamstation.streamcore.core.FocusPoint
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FocusTransformTest {
    @Test fun rotationAndSoftwareZoomAreBuiltFromTheCapturedInputs() {
        val transform = FocusTransform()
        val texture = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
        val point = FocusPoint.create(.2, .7)!!
        transform.update(texture, 1f, 1f, 0, 2f, false)
        assertEquals(.35, transform.point(point)!!.x, .00001)
        assertEquals(.4, transform.point(point)!!.y, .00001)
        transform.update(texture, 1f, 1f, 90, 1f, false)
        assertEquals(.3, transform.point(point)!!.x, .00001)
        assertEquals(.8, transform.point(point)!!.y, .00001)
    }

    @Test fun frontMirrorIsUndoneExactlyOnceAndSnapshotsDoNotChangeAfterPublication() {
        val transform = FocusTransform()
        val point = FocusPoint.create(.2, .7)!!
        assertNull(transform.point(point))
        val texture = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
        transform.update(texture, 1f, 1f, 0, 1f, true)
        texture.fill(0f)
        val sensor = transform.point(point)!!
        assertEquals(.8, sensor.x, .00001)
        assertEquals(.3, sensor.y, .00001)
        transform.update(texture, 0f, 0f, 0, 1f, false)
        assertNull(transform.point(point))
    }
}
