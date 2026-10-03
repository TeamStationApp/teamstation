#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `DictationMicrophone.swift`, declared by hand: the generated Swift header
 * also declares the app delegate, whose Objective-C superclass an
 * Objective-C++ file cannot import as a module.
 */
@interface TSDictationMicrophone : NSObject
@property (nonatomic, copy, nullable) void (^onPcm)(NSString *pcm);
@property (nonatomic, copy, nullable) void (^onEnded)(NSString *message);
- (void)start:(void (^)(NSString *_Nullable message))done;
- (void)stop;
@end

NS_ASSUME_NONNULL_END

/**
 * The `DictationMicrophone` TurboModule. The spec is generated with the
 * walk-up module, which is why the header is that pod's: codegen reads one
 * directory. `codegenConfig.ios.modulesProvider` maps the name to this class.
 */
@interface RCTDictationMicrophone : NativeDictationMicrophoneSpecBase <NativeDictationMicrophoneSpec>
@end

@implementation RCTDictationMicrophone {
  TSDictationMicrophone *_microphone;
}

RCT_EXPORT_MODULE(DictationMicrophone)

- (instancetype)init
{
  if (self = [super init]) {
    _microphone = [TSDictationMicrophone new];
    __weak RCTDictationMicrophone *weakSelf = self;
    _microphone.onPcm = ^(NSString *pcm) {
      [weakSelf emitOnPcm:@{@"pcm" : pcm}];
    };
    _microphone.onEnded = ^(NSString *message) {
      [weakSelf emitOnPcm:@{@"error" : message}];
    };
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (void)start:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_microphone start:^(NSString *message) {
    if (message != nil) {
      reject(@"microphone", message, nil);
    } else {
      resolve(nil);
    }
  }];
}

- (void)stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_microphone stop];
  resolve(nil);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeDictationMicrophoneSpecJSI>(params);
}

@end
