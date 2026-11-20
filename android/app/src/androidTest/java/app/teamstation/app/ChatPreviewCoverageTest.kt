package app.teamstation.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.soloader.SoLoader
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatPreviewCoverageTest {
    private external fun probe(filename: String): Boolean

    @Test fun registeredModuleSettlesItsPromisesAndWritesCoverage() {
        assumeTrue("Enable the native preview coverage build", BuildConfig.CHAT_PREVIEW_NATIVE_COVERAGE)
        SoLoader.loadLibrary("appmodules")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val profile = File(context.filesDir, "preview.profraw")
        assertTrue(probe(profile.absolutePath))
        assertTrue(profile.length() > 0)
    }
}
