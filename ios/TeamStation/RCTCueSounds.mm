#import <AVFoundation/AVFoundation.h>
#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

/**
 * The `CueSounds` TurboModule on iOS: the field's swish, pop and bat, played
 * from buffers JavaScript hands over once. One `AVAudioEngine` with four
 * players, so cues can overlap. Every method is one platform call; which
 * voice, when to load, the session to ask for and restarting the engine are
 * decided in `cueSoundsController.ts`. An exception is caught rather than
 * let through, so sound can never take the app down.
 */
@interface RCTCueSounds : NativeCueSoundsSpecBase <NativeCueSoundsSpec>
@end

static const NSUInteger kVoices = 4;
static const double kSampleRate = 44100;

@implementation RCTCueSounds {
  AVAudioEngine *_engine;
  NSArray<AVAudioPlayerNode *> *_players;
  AVAudioFormat *_format;
  NSMutableDictionary<NSString *, AVAudioPCMBuffer *> *_buffers;
}

RCT_EXPORT_MODULE(CueSounds)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _engine = [AVAudioEngine new];
    _format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:kSampleRate channels:1];
    _buffers = [NSMutableDictionary new];
    NSMutableArray<AVAudioPlayerNode *> *players = [NSMutableArray new];
    for (NSUInteger i = 0; i < kVoices; i++) {
      AVAudioPlayerNode *player = [AVAudioPlayerNode new];
      [_engine attachNode:player];
      [_engine connect:player to:_engine.mainMixerNode format:_format];
      [players addObject:player];
    }
    _players = players;
  }
  return self;
}

- (void)load:(NSString *)kind samples:(NSArray *)samples sampleRate:(double)sampleRate
{
  (void)sampleRate;
  @try {
    AVAudioPCMBuffer *buffer =
        [[AVAudioPCMBuffer alloc] initWithPCMFormat:_format frameCapacity:(AVAudioFrameCount)samples.count];
    buffer.frameLength = (AVAudioFrameCount)samples.count;
    float *data = buffer.floatChannelData[0];
    for (NSUInteger i = 0; i < samples.count; i++) {
      data[i] = [samples[i] floatValue] / 32767.0f;
    }
    @synchronized(self) {
      _buffers[kind] = buffer;
    }
  } @catch (NSException *exception) {
    NSLog(@"CueSounds load %@: %@", kind, exception.reason);
  }
}

- (void)play:(NSString *)kind voice:(double)voice
{
  @try {
    AVAudioPCMBuffer *buffer = nil;
    @synchronized(self) {
      buffer = _buffers[kind];
    }
    AVAudioPlayerNode *player = _players[(NSUInteger)voice % kVoices];
    [player scheduleBuffer:buffer atTime:nil options:AVAudioPlayerNodeBufferInterrupts completionHandler:nil];
    [player play];
  } @catch (NSException *exception) {
    NSLog(@"CueSounds play %@: %@", kind, exception.reason);
  }
}

- (void)stop
{
  @try {
    for (AVAudioPlayerNode *player in _players) {
      [player stop];
    }
  } @catch (NSException *exception) {
    NSLog(@"CueSounds stop: %@", exception.reason);
  }
}

- (NSNumber *)isRunning
{
  return @(_engine.running);
}

- (void)start
{
  @try {
    NSError *error = nil;
    [_engine startAndReturnError:&error];
    if (error != nil) {
      NSLog(@"CueSounds start: %@", error.localizedDescription);
    }
  } @catch (NSException *exception) {
    NSLog(@"CueSounds start: %@", exception.reason);
  }
}

- (NSString *)sessionCategory
{
  return AVAudioSession.sharedInstance.category;
}

- (void)useAmbientSession
{
  NSError *error = nil;
  AVAudioSession *session = AVAudioSession.sharedInstance;
  [session setCategory:AVAudioSessionCategoryAmbient
           withOptions:AVAudioSessionCategoryOptionMixWithOthers
                 error:&error];
  [session setActive:YES error:&error];
  if (error != nil) {
    NSLog(@"CueSounds session: %@", error.localizedDescription);
  }
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeCueSoundsSpecJSI>(params);
}
@end
