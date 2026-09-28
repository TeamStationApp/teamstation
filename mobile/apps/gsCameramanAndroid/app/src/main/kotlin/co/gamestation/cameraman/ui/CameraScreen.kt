package co.gamestation.cameraman.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import co.gamestation.cameraman.engine.AppEnvironment
import co.gamestation.cameraman.ui.theme.CameramanTokens
import kotlin.math.abs

/**
 * The operating screen: full-bleed preview, pinch to zoom, chrome in the corners, zoom on the right.
 *
 * Every piece of chrome here sits on top of moving pictures, which is the one place Material 3's
 * surface roles do not apply directly — a `surfaceContainer` behind a badge is invisible over a
 * bright field and glaring over a dark one. So the chrome uses `colorScheme.scrim` at a fixed alpha
 * and `onSurface` on top of it, which is the role pairing M3 defines for exactly this case.
 */
@Composable
fun CameraScreen(environment: AppEnvironment, onOpenSettings: () -> Unit) {
    val cameraState by environment.cameraState.collectAsStateWithLifecycle()
    val identity by environment.identity.collectAsStateWithLifecycle()
    val thermalLevel by environment.thermalLevel.collectAsStateWithLifecycle()
    val battery by environment.battery.collectAsStateWithLifecycle()

    // The gesture handlers below live inside `pointerInput`, whose block is only restarted when its
    // keys change — so anything they close over is frozen at that moment. The live camera state has
    // to be read through this or a drag would seed itself from whatever the zoom was when the
    // pointer input was last set up.
    val liveState by rememberUpdatedState(cameraState)

    // The zoom the gesture started from. Both gestures are relative to this rather than to the live
    // value, which is what makes them track the fingers instead of drifting.
    var zoomAtGestureStart by remember { mutableStateOf<Double?>(null) }
    var scrubAtGestureStart by remember { mutableStateOf<Double?>(null) }
    // Compose reports a *delta* per event where SwiftUI reports the total since the gesture began,
    // so the total has to be accumulated here. Feeding one event's delta to arithmetic that expects
    // the whole gesture recomputes the zoom from the start point every frame, and the picture jerks
    // a few pixels and springs back rather than following the finger.
    var scrubbedPoints by remember { mutableFloatStateOf(0f) }
    var pinchedScale by remember { mutableDoubleStateOf(1.0) }
    // Centre-to-centre gap between adjacent pills, measured from the drawn column.
    var pointsPerSegment by remember { mutableFloatStateOf(72f) }
    // Whether the current gesture's first finger landed within [CameramanTokens.systemGestureBand]
    // of the top or bottom edge. Such a gesture is on its way to the system's shade or home bar and
    // leaves the zoom alone for its whole length, however far it then travels into the picture.
    var startedInSystemBand by remember { mutableStateOf(false) }
    // The zoom rail's span in the window, top pill to bottom pill. A vertical drag zooms only when
    // its first finger lands inside it; the rail stops short of both edges, so this also keeps the
    // drag clear of the system's shade and home bar.
    var railTop by remember { mutableFloatStateOf(Float.NaN) }
    var railBottom by remember { mutableFloatStateOf(Float.NaN) }
    var startedOutsideRail by remember { mutableStateOf(false) }

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .testTag("camera-screen"),
        color = MaterialTheme.colorScheme.background
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            CameraPreview(
                camera = environment.camera,
                modifier = Modifier
                    .fillMaxSize()
                    // Where the first finger landed, read on the Initial pass so it is settled
                    // before either detector below sees the down. The drag detector only reports a
                    // position once touch slop is crossed, which is already some way off the edge.
                    // The preview is edge to edge, so its bounds are the glass.
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            val down = awaitFirstDown(
                                requireUnconsumed = false,
                                pass = PointerEventPass.Initial
                            )
                            val band = CameramanTokens.systemGestureBand.toPx()
                            startedInSystemBand =
                                down.position.y < band || down.position.y > size.height - band
                            startedOutsideRail = !railTop.isNaN() &&
                                (down.position.y < railTop || down.position.y > railBottom)
                        }
                    }
                    .pointerInput(Unit) {
                        detectTransformGestures { _, _, zoom, _ ->
                            if (startedInSystemBand) return@detectTransformGestures
                            val start = zoomAtGestureStart ?: liveState.deviceZoom.also {
                                pinchedScale = 1.0
                            }
                            zoomAtGestureStart = start
                            // Multiplied, not assigned: each event carries only what changed since
                            // the last one.
                            pinchedScale *= zoom.toDouble()
                            environment.camera.setDeviceZoom(
                                liveState.mapping.pinchedDeviceZoom(start, pinchedScale)
                            )
                        }
                        zoomAtGestureStart = null
                        pinchedScale = 1.0
                    }
                    // Vertical drag that starts between the top and bottom pills, anywhere across
                    // the screen. Up zooms in. A drag as long as one pill-to-pill gap walks one
                    // segment, so the rail's full height walks the whole range.
                    .pointerInput(Unit) {
                        detectDragGestures(
                            onDragStart = {
                                scrubAtGestureStart = liveState.displayedZoom
                                scrubbedPoints = 0f
                            },
                            onDragEnd = { scrubAtGestureStart = null },
                            onDragCancel = { scrubAtGestureStart = null }
                        ) { change, dragAmount ->
                            if (startedOutsideRail) return@detectDragGestures
                            change.consume()
                            scrubbedPoints -= dragAmount.y
                            val start = scrubAtGestureStart ?: liveState.displayedZoom
                            scrubAtGestureStart = start
                            environment.camera.setDisplayedZoom(
                                liveState.mapping.displayedZoomByDragging(
                                    start = start,
                                    draggedPoints = scrubbedPoints.toDouble(),
                                    pointsPerSegment = pointsPerSegment.toDouble()
                                )
                            )
                        }
                    }
            )

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(CameramanTokens.chromeMargin),
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.height(CameramanTokens.chromeButtonSize)
                ) {
                    ChromeIconButton(
                        icon = Icons.Filled.Settings,
                        description = "Camera settings",
                        testTag = "settings-button",
                        onClick = onOpenSettings
                    )
                    Spacer(Modifier.width(16.dp))
                    NameBadge(identity.name)
                }

                Row {
                    ChromeIconButton(
                        icon = Icons.Filled.Cameraswitch,
                        description = "Flip camera",
                        testTag = "flip-button",
                        onClick = { environment.camera.flip() }
                    )
                }
            }

            // The zoom rail runs the full height on the right, top pill to bottom pill, so the drag
            // that walks it has as much travel as the screen allows, whether the camera offers two
            // lenses or five. The thermal and battery pills sit to its left along the top, clear of
            // the readout at the rail's middle.
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Top,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .fillMaxHeight()
                    .padding(CameramanTokens.chromeMargin)
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    // Dropped onto the same line as the camera name opposite, which sits lower than
                    // the margin because its row is as tall as the button beside it. Offsetting
                    // rather than matching that height keeps the gap down to the rail at exactly one
                    // margin.
                    modifier = Modifier.padding(top = CameramanTokens.badgeTopOffset)
                ) {
                    ThermalBadge(level = thermalLevel, animate = environment.animatesChrome)
                    battery?.let { BatteryBadge(status = it) }
                }

                ZoomScale(
                    mapping = cameraState.mapping,
                    displayedZoom = cameraState.displayedZoom,
                    onSelect = { environment.camera.setDisplayedZoom(it) },
                    onSegmentLength = { length ->
                        if (abs(pointsPerSegment - length) > 0.5f) pointsPerSegment = length
                    },
                    modifier = Modifier
                        .fillMaxHeight()
                        .onGloballyPositioned { coordinates ->
                            val bounds = coordinates.boundsInWindow()
                            railTop = bounds.top
                            railBottom = bounds.bottom
                        }
                )
            }
        }
    }
}

/**
 * The camera's name, which is the one thing an operator walking a touchline needs to read off a
 * phone without picking it up.
 */
@Composable
private fun NameBadge(name: String) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.scrim.copy(alpha = CameramanTokens.chromeScrimAlpha),
        contentColor = MaterialTheme.colorScheme.onSurface
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.height(CameramanTokens.chromePillHeight)
        ) {
            Text(
                text = name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier
                    .padding(horizontal = 14.dp)
                    .testTag("camera-name")
            )
        }
    }
}

/**
 * `FilledTonalIconButton` with its container overridden to the scrim.
 *
 * The tonal variant is the right M3 component for a secondary action, but its default
 * `secondaryContainer` is opaque and would sit as a solid block on the picture. Keeping the
 * component and replacing only the container colour keeps the touch target, the ripple, the state
 * layers and the disabled handling that a hand-rolled `Box` would have thrown away.
 */
@Composable
private fun ChromeIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    testTag: String,
    onClick: () -> Unit
) {
    FilledTonalIconButton(
        onClick = onClick,
        shape = CircleShape,
        colors = IconButtonDefaults.filledTonalIconButtonColors(
            containerColor = MaterialTheme.colorScheme.scrim
                .copy(alpha = CameramanTokens.chromeScrimAlpha),
            contentColor = MaterialTheme.colorScheme.onSurface
        ),
        modifier = Modifier
            .size(CameramanTokens.chromeButtonSize)
            .testTag(testTag)
    ) {
        Icon(icon, contentDescription = description)
    }
}
