// Exercise the same dispatcher provider implemented by React Native’s host context.
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")

package app.teamstation.app.chat

import android.app.Activity
import android.app.Instrumentation
import android.app.Application
import android.view.InputDevice
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import android.widget.LinearLayout
import app.teamstation.app.MainActivity
import app.teamstation.app.MainApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event
import com.facebook.react.uimanager.events.EventDispatcher
import com.facebook.react.uimanager.events.EventDispatcherProvider
import com.facebook.react.uimanager.events.RCTEventEmitter
import java.lang.reflect.Proxy
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.R
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.textinput.ReactEditText
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// React normally creates its map through JNI. Keep the same WritableMap contract on the JVM.
@Implements(value = Arguments::class, isInAndroidSdk = false)
class ChatKeyArgumentsShadow {
  companion object {
    @JvmStatic @Implementation fun createMap(): WritableMap = JavaOnlyMap()
  }
}

// ReactViewManager normally reads this setting through the native library.
@Implements(value = ReactNativeFeatureFlags::class, isInAndroidSdk = false)
class ChatViewFlagsShadow {
  companion object {
    @JvmStatic @Implementation fun enableViewRecyclingForView(): Boolean = false
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ChatHardwareKeysTest {
  private val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
  private val reactContext = object : BridgeReactContext(activity) {
    override fun isBridgeless() = true
  }
  private val field = ReactEditText(reactContext.also {
    com.facebook.react.uimanager.DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(it)
  })
  private val other = EditText(activity)
  private val sent = mutableListOf<String>()
  private val handler = ChatHardwareKeys { input, key ->
    assertSame(field, input)
    sent.add(key)
    true
  }
  private val up = KeyEvent.KEYCODE_DPAD_UP
  private val esc = KeyEvent.KEYCODE_ESCAPE

  init {
    activity.setContentView(LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      addView(field)
      addView(other)
    })
    field.isFocusableInTouchMode = true
    field.requestFocusFromJS()
    field.setTag(R.id.view_tag_native_id, "chatComposerEditLatest")
  }

  private fun event(key: Int = up, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0,
                    modifiers: Int = 0, flags: Int = 0, source: Int = InputDevice.SOURCE_KEYBOARD) =
    KeyEvent(1, 1, action, key, repeat, modifiers, 3, 0, flags, source)

  @Test fun applicationRegistersTheChatComposerPackageOnce() {
    val app = Instrumentation.newApplication(MainApplication::class.java, activity.applicationContext) as MainApplication
    assertEquals(1, app.reactPackages().filterIsInstance<ChatComposerKeysPackage>().size)
  }

  @Test
  @Config(shadows = [ChatViewFlagsShadow::class])
  fun composerClaimsEscapeBeforeTheInputMethodWhileOtherKeysContinue() {
    val context = ThemedReactContext(reactContext, activity, "TeamStation", 1)
    val manager = ChatComposerKeysPackage().createViewManagers(reactContext).single() as ChatComposerKeysManager
    assertEquals("TSChatComposerKeys", manager.name)
    assertTrue(manager.createViewInstance(context) is ChatComposerKeysView)

    val row = ChatComposerKeysView(context, handler)
    (field.parent as android.view.ViewGroup).removeView(field)
    activity.setContentView(row)
    row.addView(field)
    field.requestFocusFromJS()
    assertSame(field, row.findFocus())
    field.setTag(R.id.view_tag_native_id, "chatComposerCancelEdit")
    assertTrue(row.dispatchKeyEventPreIme(event(esc)))
    assertTrue(row.dispatchKeyEventPreIme(event(esc, KeyEvent.ACTION_UP)))
    assertEquals(listOf("Escape"), sent)
    field.setTag(R.id.view_tag_native_id, "tessComposerField")
    assertFalse(row.dispatchKeyEventPreIme(event(esc)))
  }

  @Test
  @Config(shadows = [ChatKeyArgumentsShadow::class])
  fun activityDeliversTheFieldEventToTheReactDispatcher() {
    val host = Robolectric.buildActivity(MainActivity::class.java).get()
    var delivered: Event<*>? = null
    val dispatcher = Proxy.newProxyInstance(
      EventDispatcher::class.java.classLoader, arrayOf(EventDispatcher::class.java)
    ) { _, method, args ->
      check(method.name == "dispatchEvent")
      delivered = args[0] as Event<*>
      null
    } as EventDispatcher
    val context = object : BridgeReactContext(activity), EventDispatcherProvider {
      override fun isBridgeless() = true
      override fun getEventDispatcher() = dispatcher
    }
    val input = ReactEditText(context)
    input.id = 212
    input.setTag(R.id.view_tag_native_id, "chatComposerEditLatest")
    activity.setContentView(input)
    input.isFocusableInTouchMode = true
    input.requestFocusFromJS()
    assertTrue(input.hasFocus())
    org.robolectric.Shadows.shadowOf(host).setCurrentFocus(input)
    assertSame(input, host.currentFocus)
    assertTrue(host.dispatchKeyEvent(event()))
    assertTrue(host.dispatchKeyEvent(event(action = KeyEvent.ACTION_UP)))
    val emitted = requireNotNull(delivered)
    assertEquals("topKeyPress", emitted.getEventName())
    assertEquals(input.id, emitted.viewTag)
    assertFalse(emitted.canCoalesce())
    var key: String? = null
    val receiver = Proxy.newProxyInstance(
      RCTEventEmitter::class.java.classLoader, arrayOf(RCTEventEmitter::class.java)
    ) { _, method, args ->
      check(method.name == "receiveEvent")
      key = (args[2] as WritableMap).getString("key")
      null
    } as RCTEventEmitter
    emitted.dispatch(receiver)
    assertEquals("ArrowUp", key)
  }

  @Test fun matchingKeyIsDeliveredOnceAndItsReleaseIsKept() {
    assertTrue(handler.dispatch(field, event()))
    field.setTag(R.id.view_tag_native_id, "chatComposerCancelEdit")
    assertTrue(handler.dispatch(field, event(repeat = 1)))
    assertTrue(handler.dispatch(other, event(action = KeyEvent.ACTION_UP)))
    assertFalse(handler.dispatch(other, event(action = KeyEvent.ACTION_UP)))
    field.setText("Practice")
    assertTrue(handler.dispatch(field, event(esc)))
    assertEquals(listOf("ArrowUp", "Escape"), sent)
  }

  @Test fun nextHardwarePressInterruptsTheEarlierLookupAndKeepsItsDefaultHandling() {
    val activityKeys = ChatHardwareKeys { _, key -> sent.add(key); true }
    for (key in listOf(esc, KeyEvent.KEYCODE_DPAD_LEFT)) {
      assertTrue(handler.dispatch(field, event(up)))
      assertTrue(handler.dispatch(field, event(up, KeyEvent.ACTION_UP)))
      assertFalse(activityKeys.dispatch(field, event(key)))
      assertFalse(handler.dispatch(field, event(key)))
      assertFalse(activityKeys.dispatch(field, event(key, KeyEvent.ACTION_UP)))
    }
    assertEquals(listOf("ArrowUp", "Escape", "ArrowUp", "Unidentified"), sent)
  }

  @Test fun otherFieldsTextCompositionsAndModifiedInputKeepTheirKeys() {
    assertFalse(handler.dispatch(null, event()))
    assertFalse(handler.dispatch(other, event()))
    assertFalse(handler.dispatch(field, event(KeyEvent.KEYCODE_ENTER)))
    assertFalse(handler.dispatch(field, event(esc)))
    assertFalse(handler.dispatch(field, event(action = KeyEvent.ACTION_MULTIPLE)))
    assertFalse(handler.dispatch(field, event(repeat = 2)))
    for (mod in listOf(KeyEvent.META_ALT_ON, KeyEvent.META_CTRL_ON, KeyEvent.META_SHIFT_ON, KeyEvent.META_META_ON))
      assertFalse(handler.dispatch(field, event(modifiers = mod)))
    assertFalse(handler.dispatch(field, event(flags = KeyEvent.FLAG_SOFT_KEYBOARD)))
    assertFalse(handler.dispatch(field, event(source = InputDevice.SOURCE_TOUCHSCREEN)))
    field.setText(" ")
    assertFalse(handler.dispatch(field, event()))
    field.setTag(R.id.view_tag_native_id, "chatComposerCancelEdit")
    BaseInputConnection.setComposingSpans(field.text!!)
    assertFalse(handler.dispatch(field, event(esc)))
    BaseInputConnection.removeComposingSpans(field.text!!)
    assertFalse(handler.dispatch(field, event()))
    field.setTag(R.id.view_tag_native_id, "tessComposerField")
    assertFalse(handler.dispatch(field, event(esc)))
    field.setTag(R.id.view_tag_native_id, "chatComposerCancelEdit")
    assertFalse(ChatHardwareKeys { _, _ -> false }.dispatch(field, event(esc)))
    other.requestFocus()
    assertFalse(handler.dispatch(field, event(esc)))
    assertTrue(sent.isEmpty())
  }
}
