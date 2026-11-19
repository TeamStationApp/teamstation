package app.teamstation.app.browser

import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/** Open browser-owned pages without Android resolving them back into this app. */
class ExternalBrowserModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
  private var lastBrowser: String? = null

  override fun getName(): String = "TSExternalBrowser"

  @ReactMethod
  fun open(url: String, promise: Promise) = openInBrowser(url, promise, chat = false)

  @ReactMethod
  fun openChatLink(url: String, promise: Promise) = openInBrowser(url, promise, chat = true)

  private fun openInBrowser(url: String, promise: Promise, chat: Boolean) {
    UiThreadUtil.runOnUiThread {
      try {
        val uri = Uri.parse(url)
        require(!uri.host.isNullOrEmpty() && uri.userInfo == null)
        require(uri.scheme == "https" || (chat && uri.scheme == "http"))
        val context = reactApplicationContext
        val manager = context.packageManager
        val browserSelector = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER)
        val packages = manager.queryIntentActivities(browserSelector, 0)
            .map { it.activityInfo.packageName }
            .filter { it != context.packageName }.distinct()
        // Account links return to the browser that initiated sign-in. People
        // opening a chat link expect their default browser for that scheme.
        val remembered = if (chat) null else {
          val caller = context.currentActivity?.referrer?.takeIf { it.scheme == "android-app" }?.host
          listOfNotNull(caller, lastBrowser).firstOrNull { it in packages }
        }
        val preferred = remembered
            ?: Intent(Intent.ACTION_VIEW, Uri.parse("${uri.scheme}://example.invalid/"))
                .addCategory(Intent.CATEGORY_BROWSABLE).resolveActivity(manager)?.packageName
                ?.takeIf { it in packages }
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        val launch = if (preferred != null) {
          if (!chat) lastBrowser = preferred
          view.setPackage(preferred)
        } else {
          require(packages.isNotEmpty())
          val targets = packages.map { Intent(view).setPackage(it) }
          Intent.createChooser(targets.first(), "Choose browser")
              .putExtra(Intent.EXTRA_INITIAL_INTENTS, targets.drop(1).toTypedArray())
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(launch)
        promise.resolve(null)
      } catch (_: Exception) {
        promise.reject("browser_unavailable", "An external browser is not available")
      }
    }
  }
}
