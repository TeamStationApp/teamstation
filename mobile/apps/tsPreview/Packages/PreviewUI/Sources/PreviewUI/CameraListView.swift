import CameramanControlUI
import CameramanRemote
import DirectorRTSP
import PreviewCore
import SwiftUI

public struct CameraListView: View {
  @Bindable var environment: AppEnvironment
  @State private var focusedID: String?
  @State private var focusProgress: CGFloat = 0
  @State private var isScrubbing = false
  @State private var dragStartProgress: CGFloat = 0
  /// The Cameraman whose control screen is open, if any.
  @State private var controlledCamera: PreviewCamera?

  public init(environment: AppEnvironment) {
    self.environment = environment
  }

  private let tileSpacing: CGFloat = 8
  private let tileCornerRadius: CGFloat = 6
  private let focusGreen = Color(red: 0.18, green: 0.86, blue: 0.32)

  public var body: some View {
    GeometryReader { geo in
      let insets = geo.safeAreaInsets
      let full = CGSize(
        width: geo.size.width + insets.leading + insets.trailing,
        height: geo.size.height + insets.top + insets.bottom
      )
      let landscape = full.width > full.height
      Group {
        if environment.cameras.isEmpty {
          emptyState
        } else if landscape {
          landscapeStage(container: full, insets: insets)
            .ignoresSafeArea()
        } else {
          portraitList(container: geo.size, topInset: insets.top)
        }
      }
    }
    .background(Color.black)
    .preferredColorScheme(.dark)
    .persistentSystemOverlays(.hidden)
    .onAppear { environment.start() }
    .onDisappear { environment.stop() }
    .onChange(of: environment.cameras.map(\.id)) { _, ids in
      if let focusedID, ids.contains(focusedID) { return }
      focusedID = ids.first
      focusProgress = 0
    }
    .fullScreenCover(item: $controlledCamera) { camera in
      CameraControlCover(camera: camera, animatesChrome: !environment.isUITest) {
        controlledCamera = nil
      }
    }
  }

  private var emptyState: some View {
    VStack(spacing: 12) {
      Text(environment.statusMessage)
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("preview-status")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityIdentifier("preview-scroll")
  }

  private func portraitList(container: CGSize, topInset: CGFloat) -> some View {
    let video = Self.videoSize(in: container, landscape: false)
    return ScrollView(.vertical) {
      LazyVStack(spacing: tileSpacing) {
        ForEach(Array(environment.cameras.enumerated()), id: \.element.id) { index, camera in
          cameraTile(camera, index: index, videoSize: video, showName: true)
            .frame(width: container.width, height: video.height)
        }
      }
      .padding(.top, topInset)
    }
    .scrollBounceBehavior(.always)
    .scrollIndicators(.hidden)
    .ignoresSafeArea(edges: [.top, .bottom])
    .accessibilityIdentifier("preview-scroll")
  }

  private func landscapeStage(container: CGSize, insets: EdgeInsets) -> some View {
    let layout = Self.landscapeLayout(container: container, spacing: tileSpacing)
    let pageSize = CGSize(width: layout.mainWidth, height: container.height)
    let mainStride = pageSize.height + tileSpacing
    return HStack(alignment: .center, spacing: tileSpacing) {
      thumbnailRail(
        columnWidth: layout.thumbWidth,
        topInset: PreviewCameraRules.landscapeThumbTopInset(
          top: insets.top,
          leading: insets.leading,
          trailing: insets.trailing
        )
      )
      mainStage(pageSize: pageSize, video: layout.video, mainStride: mainStride)
    }
    .frame(width: container.width, height: container.height)
    .onAppear {
      if focusedID == nil {
        focusedID = environment.cameras.first?.id
        focusProgress = 0
      }
    }
  }

  private func thumbnailRail(
    columnWidth: CGFloat,
    topInset: CGFloat
  ) -> some View {
    let thumbWidth = columnWidth
    let thumbHeight = thumbWidth * 9 / 16
    let thumbStride = thumbHeight + tileSpacing
    let ids = environment.cameras.map(\.id)
    let overlayY = PreviewCameraRules.overlayOffset(progress: focusProgress, thumbStride: thumbStride)
    return ScrollViewReader { proxy in
      ScrollView(.vertical) {
        VStack(spacing: 0) {
          Color.clear
            .frame(height: topInset)
            .id("preview-thumb-top-inset")
          ZStack(alignment: .topLeading) {
            LazyVStack(spacing: tileSpacing) {
              ForEach(Array(environment.cameras.enumerated()), id: \.element.id) { index, camera in
                cameraTile(
                  camera,
                  index: index,
                  videoSize: CGSize(width: thumbWidth, height: thumbHeight),
                  showName: false
                )
                .id(camera.id)
                .onTapGesture { snapTo(index: index) }
                .accessibilityIdentifier("preview-thumb-\(index + 1)")
              }
            }
            RoundedRectangle(cornerRadius: tileCornerRadius, style: .continuous)
              .strokeBorder(focusGreen, lineWidth: 3)
              .background(.clear)
              .contentShape(RoundedRectangle(cornerRadius: tileCornerRadius, style: .continuous))
              .frame(width: thumbWidth, height: thumbHeight)
              .offset(y: overlayY)
              .accessibilityIdentifier("preview-thumb-focus")
              .highPriorityGesture(
                scrubGesture(stride: thumbStride, count: ids.count, inverts: false)
              )
          }
        }
      }
      .scrollDisabled(isScrubbing)
      .scrollBounceBehavior(.always)
      .scrollIndicators(.hidden)
      .ignoresSafeArea(edges: [.top, .bottom])
      .onChange(of: focusProgress) { _, progress in
        guard !isScrubbing else { return }
        let index = PreviewCameraRules.nearestIndex(progress: progress, count: ids.count)
        guard ids.indices.contains(index) else { return }
        if index == 0 {
          proxy.scrollTo("preview-thumb-top-inset", anchor: .top)
        } else {
          proxy.scrollTo(ids[index], anchor: .center)
        }
      }
    }
    .frame(width: columnWidth)
    .coordinateSpace(.named("preview-thumbs"))
    .accessibilityIdentifier("preview-thumbs")
  }

  private func mainStage(pageSize: CGSize, video: CGSize, mainStride: CGFloat) -> some View {
    let count = environment.cameras.count
    return VStack(spacing: tileSpacing) {
      ForEach(Array(environment.cameras.enumerated()), id: \.element.id) { index, camera in
        cameraTile(camera, index: index, videoSize: video, showName: true)
          .frame(width: pageSize.width, height: pageSize.height)
      }
    }
    .offset(y: -focusProgress * mainStride)
    .frame(width: pageSize.width, height: pageSize.height, alignment: .top)
    .clipped()
    .contentShape(Rectangle())
    .gesture(scrubGesture(stride: mainStride, count: count, inverts: true))
    .accessibilityIdentifier("preview-scroll")
  }

  /// Shared drag for the thumbnail outline and the main stage. `inverts` is true
  /// for the main view (drag up reveals the next camera). Snap only on release.
  private func scrubGesture(stride: CGFloat, count: Int, inverts: Bool) -> some Gesture {
    DragGesture(minimumDistance: 1, coordinateSpace: .local)
      .onChanged { value in
        if !isScrubbing {
          isScrubbing = true
          dragStartProgress = focusProgress
        }
        guard stride > 0 else { return }
        let delta = value.translation.height / stride
        let next = inverts ? dragStartProgress - delta : dragStartProgress + delta
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
          focusProgress = PreviewCameraRules.focusProgress(
            offset: next * stride,
            pageStride: stride,
            count: count
          )
        }
      }
      .onEnded { _ in
        let index = PreviewCameraRules.nearestIndex(progress: focusProgress, count: count)
        isScrubbing = false
        snapTo(index: index)
      }
  }

  private func snapTo(index: Int) {
    guard environment.cameras.indices.contains(index) else { return }
    withAnimation(.easeInOut(duration: 0.25)) {
      focusProgress = CGFloat(index)
      focusedID = environment.cameras[index].id
    }
  }

  private func cameraTile(
    _ camera: PreviewCamera,
    index: Int,
    videoSize: CGSize,
    showName: Bool
  ) -> some View {
    PreviewVideoView(renderer: camera.renderer)
      .frame(width: videoSize.width, height: videoSize.height)
      .clipShape(RoundedRectangle(cornerRadius: tileCornerRadius, style: .continuous))
      .overlay(alignment: .topLeading) {
        if showName {
          Text(camera.advertisedName)
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 6))
            .padding(8)
            .accessibilityIdentifier("preview-tile-name-\(index + 1)")
        }
      }
      // The three-dot button, only on a Cameraman and only where the tile is big enough to
      // carry it: the landscape thumbnails (72–160 pt) hide it and the main stage shows it.
      .overlay(alignment: .topTrailing) {
        if showName, camera.hasCameraControl {
          Button {
            controlledCamera = camera
          } label: {
            Image(systemName: "ellipsis")
              .rotationEffect(.degrees(90))
              .font(.system(size: 16, weight: .bold))
              .foregroundStyle(.white)
              .frame(width: 36, height: 36)
              .background(.black.opacity(0.45), in: Capsule())
          }
          .buttonStyle(.plain)
          .padding(8)
          .accessibilityIdentifier("preview-tile-menu-\(index + 1)")
          .accessibilityLabel("Camera controls")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityIdentifier("preview-tile-\(index + 1)")
      .accessibilityElement(children: .contain)
  }

  /// Portrait: 16:9 from the display width. Landscape: leftover column for thumbs,
  /// remaining width × full height for the 16:9 picture.
  static func videoSize(in container: CGSize, landscape: Bool) -> CGSize {
    if landscape {
      return landscapeLayout(container: container, spacing: 8).video
    }
    let width = container.width
    return CGSize(width: width, height: width * 9 / 16)
  }

  static func landscapeLayout(container: CGSize, spacing: CGFloat) -> (
    thumbWidth: CGFloat,
    mainWidth: CGFloat,
    video: CGSize
  ) {
    let fullHeightWidth = container.height * 16 / 9
    let leftover = container.width - fullHeightWidth - spacing
    let thumbWidth = min(160, max(72, leftover))
    let mainWidth = max(container.width - thumbWidth - spacing, 1)
    let video = aspectFitSize(aspect: 16 / 9, in: CGSize(width: mainWidth, height: container.height))
    if container.width <= container.height {
      let width = container.width
      return (0, width, CGSize(width: width, height: width * 9 / 16))
    }
    return (thumbWidth, mainWidth, video)
  }

  static func aspectFitSize(aspect: CGFloat, in size: CGSize) -> CGSize {
    guard size.width > 0, size.height > 0 else { return .zero }
    if size.width / size.height > aspect {
      return CGSize(width: size.height * aspect, height: size.height)
    }
    return CGSize(width: size.width, height: size.width / aspect)
  }
}
