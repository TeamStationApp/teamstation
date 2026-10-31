#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^TSPhoneStreamReply)(id _Nullable value, NSString *_Nullable code, NSString *_Nullable message);

/**
 * `PhoneStreamBridge.swift`, declared by hand: the generated Swift header
 * also declares the app delegate, whose Objective-C superclass an
 * Objective-C++ file cannot import as a module.
 */
@interface TSPhoneStreamBridge : NSObject
@property (nonatomic, copy, nullable) void (^onStatus)(NSDictionary<NSString *, id> *status);
@property (nonatomic, copy, nullable) void (^onRadar)(NSDictionary<NSString *, id> *radar);
@property (nonatomic, copy, nullable) void (^onUpload)(NSDictionary<NSString *, id> *upload);
- (void)startObserving;
- (void)stopObserving;
- (void)capabilities:(TSPhoneStreamReply)reply;
- (void)open:(NSString *)angleName
    audioEnabled:(BOOL)audioEnabled
  disabledLenses:(NSArray<NSString *> *)disabledLenses
           reply:(TSPhoneStreamReply)reply;
- (void)close:(TSPhoneStreamReply)reply;
- (void)setAngleName:(NSString *)name reply:(TSPhoneStreamReply)reply;
- (void)startRecording:(NSString *)rtmpUrl
          liveStreamId:(NSString *)liveStreamId
                gameId:(NSString *)gameId
             angleName:(NSString *)angleName
               request:(NSDictionary<NSString *, id> *)request
                 reply:(TSPhoneStreamReply)reply;
- (void)stopRecording:(TSPhoneStreamReply)reply;
- (void)interruptedSession:(TSPhoneStreamReply)reply;
- (void)resumeInterrupted:(NSDictionary<NSString *, id> *)request reply:(TSPhoneStreamReply)reply;
- (void)setZoom:(double)displayed;
- (void)pinch:(double)scale ended:(BOOL)ended;
- (void)zoomScale:(TSPhoneStreamReply)reply;
- (void)lenses:(TSPhoneStreamReply)reply;
- (void)setDisabledLenses:(NSArray<NSString *> *)ids reply:(TSPhoneStreamReply)reply;
- (void)flip:(TSPhoneStreamReply)reply;
- (void)setAudioEnabled:(BOOL)enabled reply:(TSPhoneStreamReply)reply;
- (void)radarSetEnabled:(BOOL)enabled reply:(TSPhoneStreamReply)reply;
- (void)radarScan:(TSPhoneStreamReply)reply;
- (void)radarStopScan:(TSPhoneStreamReply)reply;
- (void)radarPair:(NSString *)serial reply:(TSPhoneStreamReply)reply;
- (void)radarUnpair:(NSString *)serial reply:(TSPhoneStreamReply)reply;
- (void)radarState:(TSPhoneStreamReply)reply;
- (void)recordings:(TSPhoneStreamReply)reply;
- (void)uploadRecording:(NSString *)liveStreamId
                apiBase:(NSString *)apiBase
                  token:(NSString *)token
                  title:(NSString *)title
                  reply:(TSPhoneStreamReply)reply;
- (void)resumePendingUploads:(NSString *)apiBase token:(NSString *)token reply:(TSPhoneStreamReply)reply;
- (void)cancelUpload:(NSString *)liveStreamId reply:(TSPhoneStreamReply)reply;
- (void)deleteRecording:(NSString *)liveStreamId reply:(TSPhoneStreamReply)reply;
- (void)openInApp:(NSString *)url reply:(TSPhoneStreamReply)reply;
@end

NS_ASSUME_NONNULL_END

/**
 * The `TSPhoneStream` TurboModule: the phone's streaming and recording engine
 * (`PhoneStreamEngine`, through `PhoneStreamBridge.swift`). It only converts
 * arguments and results; a refusal rejects with the engine's error code. The
 * spec is generated with the walk-up module, which is why the header is that
 * pod's. `codegenConfig.ios.modulesProvider` maps the name to this class.
 */
@interface RCTPhoneStream : NativePhoneStreamSpecBase <NativePhoneStreamSpec>
@end

@implementation RCTPhoneStream {
  TSPhoneStreamBridge *_bridge;
}

RCT_EXPORT_MODULE(TSPhoneStream)

- (instancetype)init
{
  if (self = [super init]) {
    _bridge = [TSPhoneStreamBridge new];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/** Events flow once JavaScript can hear them. */
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  __weak RCTPhoneStream *weakSelf = self;
  _bridge.onStatus = ^(NSDictionary *status) {
    [weakSelf emitOnStatus:status];
  };
  _bridge.onRadar = ^(NSDictionary *radar) {
    [weakSelf emitOnRadar:radar];
  };
  _bridge.onUpload = ^(NSDictionary *upload) {
    [weakSelf emitOnUpload:upload];
  };
  [_bridge startObserving];
}

- (void)invalidate
{
  [_bridge stopObserving];
}

static TSPhoneStreamReply settle(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)
{
  return ^(id value, NSString *code, NSString *message) {
    if (code != nil) {
      reject(code, message ?: code, nil);
    } else {
      resolve(value);
    }
  };
}

static NSDictionary *requestDictionary(JS::NativePhoneStream::NativePhoneStreamRequest &request)
{
  return @{
    @"apiBase" : request.apiBase() ?: @"",
    @"token" : request.token() ?: @"",
    @"deviceId" : request.deviceId() ?: @"",
    @"deviceModel" : request.deviceModel() ?: @"",
  };
}

- (void)capabilities:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge capabilities:settle(resolve, reject)];
}

- (void)open:(NSString *)angleName
    audioEnabled:(BOOL)audioEnabled
  disabledLenses:(NSArray *)disabledLenses
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [_bridge open:angleName audioEnabled:audioEnabled disabledLenses:disabledLenses reply:settle(resolve, reject)];
}

- (void)close:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge close:settle(resolve, reject)];
}

- (void)setAngleName:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setAngleName:name reply:settle(resolve, reject)];
}

- (void)startRecording:(NSString *)rtmpUrl
          liveStreamId:(NSString *)liveStreamId
                gameId:(NSString *)gameId
             angleName:(NSString *)angleName
               request:(JS::NativePhoneStream::NativePhoneStreamRequest &)request
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_bridge startRecording:rtmpUrl
             liveStreamId:liveStreamId
                   gameId:gameId
                angleName:angleName
                  request:requestDictionary(request)
                    reply:settle(resolve, reject)];
}

- (void)stopRecording:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge stopRecording:settle(resolve, reject)];
}

- (void)interruptedSession:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge interruptedSession:settle(resolve, reject)];
}

- (void)resumeInterrupted:(JS::NativePhoneStream::NativePhoneStreamRequest &)request
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [_bridge resumeInterrupted:requestDictionary(request) reply:settle(resolve, reject)];
}

- (void)setZoom:(double)displayed
{
  [_bridge setZoom:displayed];
}

- (void)pinch:(double)scale ended:(BOOL)ended
{
  [_bridge pinch:scale ended:ended];
}

- (void)zoomScale:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge zoomScale:settle(resolve, reject)];
}

- (void)lenses:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge lenses:settle(resolve, reject)];
}

- (void)setDisabledLenses:(NSArray *)ids resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setDisabledLenses:ids reply:settle(resolve, reject)];
}

- (void)flip:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge flip:settle(resolve, reject)];
}

- (void)setAudioEnabled:(BOOL)enabled resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge setAudioEnabled:enabled reply:settle(resolve, reject)];
}

- (void)radarSetEnabled:(BOOL)enabled resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarSetEnabled:enabled reply:settle(resolve, reject)];
}

- (void)radarScan:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarScan:settle(resolve, reject)];
}

- (void)radarStopScan:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarStopScan:settle(resolve, reject)];
}

- (void)radarPair:(NSString *)serial resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarPair:serial reply:settle(resolve, reject)];
}

- (void)radarUnpair:(NSString *)serial resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarUnpair:serial reply:settle(resolve, reject)];
}

- (void)radarState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge radarState:settle(resolve, reject)];
}

- (void)recordings:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge recordings:settle(resolve, reject)];
}

- (void)uploadRecording:(NSString *)liveStreamId
                apiBase:(NSString *)apiBase
                  token:(NSString *)token
                  title:(NSString *)title
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [_bridge uploadRecording:liveStreamId apiBase:apiBase token:token title:title reply:settle(resolve, reject)];
}

- (void)resumePendingUploads:(NSString *)apiBase
                       token:(NSString *)token
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  [_bridge resumePendingUploads:apiBase token:token reply:settle(resolve, reject)];
}

- (void)cancelUpload:(NSString *)liveStreamId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_bridge cancelUpload:liveStreamId reply:settle(resolve, reject)];
}

- (void)deleteRecording:(NSString *)liveStreamId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [_bridge deleteRecording:liveStreamId reply:settle(resolve, reject)];
}

- (void)appInstalled:(NSString *)packageName
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  resolve(@YES);
}

- (void)openInApp:(NSString *)url
      packageName:(NSString *)packageName
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [_bridge openInApp:url reply:settle(resolve, reject)];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativePhoneStreamSpecJSI>(params);
}

@end
