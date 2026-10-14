#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

#import "../TSCatch.h"

NSString *TSInstallDictationTap(AVAudioEngine *engine, AVAudioNodeTapBlock tap)
{
  AVAudioInputNode *input = nil;
  @try {
    // Reading the input node, or preparing the engine before this, throws
    // when the node does not exist yet. Swift cannot catch that, so it is
    // caught here. nil uses the bus format: a format read before the route
    // settles does not match it, and that mismatch throws too.
    input = engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate == 0 || format.channelCount == 0) {
      return @"This phone has no microphone";
    }
    // A tap left from a start that died is what makes the next install throw.
    @try {
      [input removeTapOnBus:0];
    } @catch (NSException *ignored) {
    }
    [input installTapOnBus:0 bufferSize:4096 format:nil block:tap];
  } @catch (NSException *exception) {
    if (input != nil) {
      @try {
        [input removeTapOnBus:0];
      } @catch (NSException *ignored) {
      }
    }
    return exception.reason ?: @"The microphone could not be read";
  }
  return nil;
}

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
