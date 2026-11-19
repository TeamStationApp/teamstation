package app.teamstation.app.browser

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Looper
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.PromiseImpl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE, application = Application::class)
class ExternalBrowserModuleTest {
  private val app = RuntimeEnvironment.getApplication()
  private val packages = shadowOf(app.packageManager)
  private val context = BridgeReactContext(app)
  private val module = ExternalBrowserModule(context)

  private class Result : Promise by PromiseImpl(null, null) {
    var resolved = false
    var error: String? = null
    override fun resolve(value: Any?) { resolved = true }
    override fun reject(code: String?, message: String?) { error = code }
  }

  private fun activityInfoFor(pkg: String) = ResolveInfo().apply {
    activityInfo = ActivityInfo().apply {
      packageName = pkg
      name = "$pkg.Browser"
      applicationInfo = ApplicationInfo().apply { packageName = pkg }
    }
    isDefault = true
  }

  private fun installBrowser(pkg: String, defaultFor: String? = null) {
    val selector = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER)
    packages.addResolveInfoForIntent(selector, activityInfoFor(pkg))
    if (defaultFor != null) {
      val genericPage = Intent(Intent.ACTION_VIEW, Uri.parse("$defaultFor://example.invalid/"))
          .addCategory(Intent.CATEGORY_BROWSABLE)
      packages.addResolveInfoForIntent(genericPage, activityInfoFor(pkg))
    }
  }

  private fun open(url: String, chat: Boolean = true, reject: Boolean = false): Intent? {
    val result = Result()
    if (chat) module.openChatLink(url, result) else module.open(url, result)
    shadowOf(Looper.getMainLooper()).idle()
    val started = shadowOf(app).nextStartedActivity
    if (reject) {
      assertEquals("browser_unavailable", result.error)
      assertEquals(false, result.resolved)
      assertNull(started)
    } else {
      assertNull(result.error)
      assertTrue(result.resolved)
      assertNotNull(started)
    }
    return started
  }

  @Test fun chatOpensTheDisplayedHttpAndHttpsAddressesInTheirDefaultBrowsers() {
    assertEquals("TSExternalBrowser", module.name)
    installBrowser("org.example.first", defaultFor = "https")
    installBrowser("org.example.second", defaultFor = "http")
    for ((scheme, expected) in listOf("https" to "org.example.first", "http" to "org.example.second")) {
      val url = "$scheme://example.org/path?q=two%20words#part"
      val launched = open(url)!!
      assertEquals(Intent.ACTION_VIEW, launched.action)
      assertTrue(launched.hasCategory(Intent.CATEGORY_BROWSABLE))
      assertEquals(url, launched.dataString)
      assertEquals(expected, launched.`package`)
      assertTrue(launched.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }
  }

  @Test fun signInRemembersTheCallingBrowserAndChatAlwaysHonorsTheDefault() {
    installBrowser("org.example.default", defaultFor = "https")
    installBrowser("org.example.caller")
    val caller = Intent().putExtra(Intent.EXTRA_REFERRER, Uri.parse("android-app://org.example.caller"))
    val activity = Robolectric.buildActivity(Activity::class.java, caller).setup().get()
    context.onHostResume(activity)
    assertEquals("org.example.caller", open("https://example.com/signin", chat = false)!!.`package`)
    context.onHostPause()
    context.onHostResume(null)
    assertEquals("org.example.default", open("https://example.org/chat")!!.`package`)
    assertEquals("org.example.caller", open("https://example.com/resume", chat = false)!!.`package`)
    open("http://example.com/signin", chat = false, reject = true)
  }

  @Test fun withoutADefaultTheChooserContainsOnlyBrowserPackages() {
    installBrowser(app.packageName)
    installBrowser("org.example.first")
    installBrowser("org.example.second")
    val url = "https://example.org/media?q=1#scores"
    val chooser = open(url)!!
    assertEquals(Intent.ACTION_CHOOSER, chooser.action)
    val first = chooser.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)!!
    val rest = chooser.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS, Intent::class.java)!!
    val targets = listOf(first) + rest
    assertEquals(setOf("org.example.first", "org.example.second"), targets.map { it.`package` }.toSet())
    for (target in targets) {
      assertEquals(Intent.ACTION_VIEW, target.action)
      assertEquals(url, target.dataString)
      assertTrue(target.hasCategory(Intent.CATEGORY_BROWSABLE))
    }
  }

  @Test fun missingBrowserAndInvalidAddressesRejectWithoutLaunching() {
    open("https://example.org", reject = true)
    installBrowser("org.example.browser", defaultFor = "https")
    for (url in listOf("file:///notes.pdf", "https:///path", "https://person@example.org")) {
      open(url, reject = true)
    }
  }
}
