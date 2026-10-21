#import <AVFoundation/AVFoundation.h>
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/TeamStationWalkUpMusicSpec/ComponentDescriptors.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/EventEmitters.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/Props.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/**
 * `TSQrScanner`: Share Lineup's camera. It shows the back camera and reports
 * each QR code it reads through `AVCaptureMetadataOutput`. On mount it
 * reports `available`, or `unavailable` when there is no back camera, as on
 * the simulator; only once made `active` with a camera does it ask for the
 * camera, so no prompt can appear where there is none. Then it reports
 * `ready` or `denied`. The session runs on a queue of its own, and stops when
 * the view is inactive, leaves the window, or is recycled.
 * `codegenConfig.ios.componentProvider` maps the name to this class.
 */
@interface TSQrScannerComponentView : RCTViewComponentView <RCTTSQrScannerViewProtocol, AVCaptureMetadataOutputObjectsDelegate>
@end

@implementation TSQrScannerComponentView {
  AVCaptureVideoPreviewLayer *_previewLayer;
  AVCaptureSession *_session;
  dispatch_queue_t _queue;
  BOOL _active;
  BOOL _reported;
  /** A status to report once the view has its event emitter. */
  NSString *_pendingStatus;
  NSString *_lastCode;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<TSQrScannerComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const TSQrScannerProps>();
    _props = defaultProps;
    self.backgroundColor = UIColor.blackColor;
    self.clipsToBounds = YES;
    _queue = dispatch_queue_create("app.teamstation.qrscanner", DISPATCH_QUEUE_SERIAL);
    _previewLayer = [AVCaptureVideoPreviewLayer new];
    _previewLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
    [self.layer addSublayer:_previewLayer];
  }
  return self;
}

- (void)dealloc
{
  [self stopSession];
}

+ (AVCaptureDevice *)backCamera
{
  return [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                            mediaType:AVMediaTypeVideo
                                             position:AVCaptureDevicePositionBack];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<TSQrScannerProps const>(props);
  BOOL active = newProps.active;
  [super updateProps:props oldProps:oldProps];
  if (!_reported) {
    _reported = YES;
    [self emitStatus:[TSQrScannerComponentView backCamera] == nil ? @"unavailable" : @"available"];
  }
  if (active != _active) {
    _active = active;
    if (active) {
      [self startIfAllowed];
    } else {
      [self stopSession];
    }
  }
}

- (void)updateEventEmitter:(EventEmitter::Shared const &)eventEmitter
{
  [super updateEventEmitter:eventEmitter];
  if (_pendingStatus != nil) {
    NSString *status = _pendingStatus;
    _pendingStatus = nil;
    [self emitStatus:status];
  }
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _previewLayer.frame = self.bounds;
  [CATransaction commit];
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (self.window == nil) {
    [self stopSession];
  } else if (_active) {
    [self startIfAllowed];
  }
}

- (void)startIfAllowed
{
  AVCaptureDevice *camera = [TSQrScannerComponentView backCamera];
  if (camera == nil) {
    [self emitStatus:@"unavailable"];
    return;
  }
  switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]) {
    case AVAuthorizationStatusAuthorized:
      [self startSession:camera];
      break;
    case AVAuthorizationStatusNotDetermined: {
      __weak TSQrScannerComponentView *weakSelf = self;
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                               completionHandler:^(BOOL granted) {
                                 dispatch_async(dispatch_get_main_queue(), ^{
                                   TSQrScannerComponentView *view = weakSelf;
                                   if (view == nil) {
                                     return;
                                   }
                                   if (granted) {
                                     [view startIfAllowed];
                                   } else {
                                     [view emitStatus:@"denied"];
                                   }
                                 });
                               }];
      break;
    }
    default:
      [self emitStatus:@"denied"];
      break;
  }
}

- (void)startSession:(AVCaptureDevice *)camera
{
  if (!_active || self.window == nil) {
    return;
  }
  AVCaptureSession *session = _session;
  if (session == nil) {
    session = [AVCaptureSession new];
    NSError *error = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:camera error:&error];
    AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
    if (input == nil || ![session canAddInput:input] || ![session canAddOutput:output]) {
      [self emitStatus:@"unavailable"];
      return;
    }
    [session beginConfiguration];
    [session addInput:input];
    [session addOutput:output];
    [session commitConfiguration];
    [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
    if ([output.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode]) {
      output.metadataObjectTypes = @[ AVMetadataObjectTypeQRCode ];
    }
    _session = session;
    _previewLayer.session = session;
  }
  dispatch_async(_queue, ^{
    if (!session.isRunning) {
      [session startRunning];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [self emitStatus:@"ready"];
    });
  });
}

- (void)stopSession
{
  // Scan Again after a warning reads the code in view again.
  _lastCode = nil;
  AVCaptureSession *session = _session;
  if (session == nil) {
    return;
  }
  dispatch_async(_queue, ^{
    if (session.isRunning) {
      [session stopRunning];
    }
  });
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)metadataObjects
              fromConnection:(AVCaptureConnection *)connection
{
  if (!_active) {
    return;
  }
  for (AVMetadataObject *object in metadataObjects) {
    if (![object isKindOfClass:AVMetadataMachineReadableCodeObject.class]) {
      continue;
    }
    NSString *text = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
    if (text.length == 0 || [text isEqualToString:_lastCode]) {
      continue;
    }
    _lastCode = text;
    if (_eventEmitter != nullptr) {
      std::static_pointer_cast<const TSQrScannerEventEmitter>(_eventEmitter)
          ->onCode(TSQrScannerEventEmitter::OnCode{.text = std::string(text.UTF8String)});
    }
    return;
  }
}

- (void)emitStatus:(NSString *)status
{
  if (_eventEmitter == nullptr) {
    _pendingStatus = status;
    return;
  }
  std::static_pointer_cast<const TSQrScannerEventEmitter>(_eventEmitter)
      ->onStatus(TSQrScannerEventEmitter::OnStatus{.status = std::string(status.UTF8String)});
}

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  [self stopSession];
  _active = NO;
  _reported = NO;
  _lastCode = nil;
  _pendingStatus = nil;
}

@end
