#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>
#import <objc/runtime.h>

#include <cstdlib>
#include <cstring>
#include <mutex>

/**
 * Lets the app's requests leave a connection that has stopped answering.
 *
 * Every `fetch` shares React Native's one `NSURLSession`, and its requests
 * share one HTTP/2 connection to TeamStation. On a link that stalls (a phone
 * at the edge of a field's Wi-Fi) the connection's resends back off, and
 * once the link comes back nothing moves on it until its next try: the
 * queue's writes waited minutes after the signal returned. A request that
 * misses its deadline (`REQUEST_DEADLINE_MS` in `src/common/api.ts`) only
 * stops waiting for its answer; the connection stays.
 *
 * `renew` gives React Native's HTTP handler a new session, made as the old
 * one was (its configuration, the handler as its delegate, its delegate
 * queue). A session keeps its own connections, so every request after it
 * goes out on a new one, which a link that came back answers at once; the
 * old session finishes the requests already on it, whose answers reach the
 * handler as before (it finds a request's delegate by its task), and then
 * lets its connections go. A request still on the old connection can reach
 * the server after a later one sent on the new: the queue's writes are
 * chained and carry their `Idempotency-Key`, so that is theirs to bear; a
 * write sent outside the queue may land after a newer one. `-[NSURLSession flushWithCompletionHandler:]`
 * does not do this: the next request keeps the same connection. The app
 * calls `renew` when a request misses its deadline
 * (`stalledConnections.native.ts`).
 *
 * A deadline is also missed on a link that is slow but working: React
 * Native's `fetch` answers only once the whole body has come. So `renew`
 * first watches the session for `STALL_CHECK_MS`, and renews only if none of
 * its requests to TeamStation's host made progress in that time: received
 * or sent anything, or was answered. Requests to other hosts (pictures from a
 * store, another origin's fetch) are on their own connections and say
 * nothing of this one. It answers whether it renewed. A server that sends nothing
 * for longer than the deadline and the check together (a read it takes over
 * 12 s to begin answering) looks stalled too, and its session is renewed: a
 * new connection, not a lost answer.
 *
 * React Native keeps the session inside its HTTP handler (`_session` of
 * `RCTHTTPRequestHandler`, guarded by its `_mutex`, reached through
 * `RCTNetworking`'s `handlerForRequest:`). None of these is in its headers:
 * where any has gone, or changed shape, `renew` does nothing and says so
 * once. The app could register an HTTP handler of its own instead, with a
 * session it owns; that would be a copy of React Native's handler (its
 * cookies, interceptor, Wi-Fi-only setting and delegate bookkeeping) to keep
 * in step with every release, where this touches three of its members and
 * `ConnectionsTests` checks them. A React Native upgrade must pass
 * `ConnectionsTests`.
 */
@interface RCTConnections : NSObject <RCTBridgeModule>
/** The handler `networking` sends `https` requests through, or nil. */
+ (nullable id)handlerOfNetworking:(nullable id)networking;
/** Whether `handler` keeps its session, and the lock over it, where `renewSessionOf:` looks. */
+ (BOOL)keepsSession:(nullable id)handler;
/** The session `handler` sends through now, or nil (none made yet, or none kept there). */
+ (nullable NSURLSession *)sessionOfHandler:(nullable id)handler;
/**
 * Gives `handler` a new session made as its own was, and lets the old one
 * finish its requests. Answers whether `handler` keeps a session to renew;
 * one with none made yet has nothing to renew and answers YES.
 */
+ (BOOL)renewSessionOf:(nullable id)handler;
/**
 * Renews `handler`'s session unless one of its requests to `host` (any host
 * when nil) makes progress within `waitMs`: a slow answer still coming, or a
 * slow upload still going, keeps its connection. `done` is told whether it
 * renewed. Answers whether `handler` keeps a session.
 */
+ (BOOL)renewSessionOf:(nullable id)handler
                 forHost:(nullable NSString *)host
            ifStalledFor:(int64_t)waitMs
                    done:(nullable void (^)(BOOL renewed))done;
@end

/** How long `renew` watches the session for anything received before it renews it. */
static const int64_t STALL_CHECK_MS = 2000;

@implementation RCTConnections

@synthesize moduleRegistry = _moduleRegistry;

RCT_EXPORT_MODULE(TSConnections)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

+ (nullable id)handlerOfNetworking:(nullable id)networking
{
  SEL handlerForRequest = NSSelectorFromString(@"handlerForRequest:");
  if (networking == nil || ![networking respondsToSelector:handlerForRequest]) {
    return nil;
  }
  NSURLRequest *request = [NSURLRequest requestWithURL:[NSURL URLWithString:@"https://teamstation.app/"]];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
  return [networking performSelector:handlerForRequest withObject:request];
#pragma clang diagnostic pop
}

+ (BOOL)keepsSession:(nullable id)handler
{
  if (handler == nil) {
    return NO;
  }
  Ivar session = class_getInstanceVariable([handler class], "_session");
  Ivar mutex = class_getInstanceVariable([handler class], "_mutex");
  if (session == NULL || mutex == NULL) {
    return NO;
  }
  const char *sessionType = ivar_getTypeEncoding(session);
  const char *mutexType = ivar_getTypeEncoding(mutex);
  if (sessionType == NULL || sessionType[0] != '@' || mutexType == NULL) {
    return NO;
  }
  // libc++'s std::mutex, and room for it: another lock type, or a wrapper,
  // would be locked as one it is not.
  if (std::strncmp(mutexType, "{mutex=", 7) != 0) {
    return NO;
  }
  ptrdiff_t start = ivar_getOffset(mutex);
  ptrdiff_t end = (ptrdiff_t)class_getInstanceSize([handler class]);
  unsigned int count = 0;
  Ivar *ivars = class_copyIvarList([handler class], &count);
  for (unsigned int i = 0; i < count; i++) {
    ptrdiff_t offset = ivar_getOffset(ivars[i]);
    if (offset > start && offset < end) {
      end = offset;
    }
  }
  free(ivars);
  return end - start >= (ptrdiff_t)sizeof(std::mutex);
}

/** The handler's own lock over its session. */
static std::mutex &mutexOf(id handler)
{
  Ivar mutex = class_getInstanceVariable([handler class], "_mutex");
  return *reinterpret_cast<std::mutex *>(reinterpret_cast<char *>((__bridge void *)handler) + ivar_getOffset(mutex));
}

+ (nullable NSURLSession *)sessionOfHandler:(nullable id)handler
{
  if (![self keepsSession:handler]) {
    return nil;
  }
  std::lock_guard<std::mutex> lock(mutexOf(handler));
  id session = object_getIvar(handler, class_getInstanceVariable([handler class], "_session"));
  return [session isKindOfClass:[NSURLSession class]] ? session : nil;
}

+ (BOOL)renewSessionOf:(nullable id)handler
{
  if (![self keepsSession:handler]) {
    return NO;
  }
  [self renewSessionOf:handler ifStill:nil];
  return YES;
}

/**
 * Renews `handler`'s session, only while it is still `expected` when one is
 * given: a session renewed meanwhile is not this one to renew again. Answers
 * whether it renewed.
 */
+ (BOOL)renewSessionOf:(nullable id)handler ifStill:(nullable NSURLSession *)expected
{
  if (![self keepsSession:handler]) {
    return NO;
  }
  Ivar ivar = class_getInstanceVariable([handler class], "_session");
  NSURLSession *old = nil;
  {
    std::lock_guard<std::mutex> lock(mutexOf(handler));
    id current = object_getIvar(handler, ivar);
    if (![current isKindOfClass:[NSURLSession class]] || (expected != nil && current != expected)) {
      // None made yet, or another renewal came first: nothing to renew.
      return NO;
    }
    old = current;
    NSURLSession *fresh = [NSURLSession sessionWithConfiguration:old.configuration
                                                        delegate:handler
                                                   delegateQueue:old.delegateQueue];
    object_setIvar(handler, ivar, fresh);
  }
  [old finishTasksAndInvalidate];
  return YES;
}

/** A request's bytes so far, each way. */
static int64_t bytesOf(NSURLSessionTask *task)
{
  return task.countOfBytesReceived + task.countOfBytesSent;
}

/** Whether `task` is a request to `host`, or `host` is nil. */
static BOOL isFor(NSURLSessionTask *task, NSString *_Nullable host)
{
  if (host == nil) {
    return YES;
  }
  NSString *taskHost = task.originalRequest.URL.host;
  // A message to nil answers 0, which reads as NSOrderedSame.
  return taskHost != nil && [taskHost caseInsensitiveCompare:host] == NSOrderedSame;
}

/**
 * Whether any request to `host` made progress since `before` (its tasks,
 * each with its bytes then) as `now` finds them: one of them moved bytes or
 * was answered, or one sent since has received something.
 */
static BOOL progressed(NSDictionary<NSNumber *, NSArray *> *before, NSArray<NSURLSessionTask *> *now, NSString *_Nullable host)
{
  for (NSArray *entry in before.allValues) {
    NSURLSessionTask *task = entry[0];
    if (bytesOf(task) > [entry[1] longLongValue]) {
      return YES;
    }
    if (task.state == NSURLSessionTaskStateCompleted && task.error == nil) {
      return YES;
    }
  }
  for (NSURLSessionTask *task in now) {
    if (isFor(task, host) && before[@(task.taskIdentifier)] == nil && task.countOfBytesReceived > 0) {
      return YES;
    }
  }
  return NO;
}

+ (BOOL)renewSessionOf:(nullable id)handler
                 forHost:(nullable NSString *)host
            ifStalledFor:(int64_t)waitMs
                    done:(nullable void (^)(BOOL renewed))done
{
  if (![self keepsSession:handler]) {
    return NO;
  }
  NSURLSession *session = [self sessionOfHandler:handler];
  if (session == nil) {
    // None made yet: no request has been sent, so none is stalled.
    if (done != nil) {
      done(NO);
    }
    return YES;
  }
  [session getAllTasksWithCompletionHandler:^(NSArray<__kindof NSURLSessionTask *> *tasks) {
    // The tasks themselves, kept: one answered in the wait leaves the
    // session's list, and still counts.
    NSMutableDictionary<NSNumber *, NSArray *> *before = [NSMutableDictionary dictionary];
    for (NSURLSessionTask *task in tasks) {
      if (isFor(task, host)) {
        before[@(task.taskIdentifier)] = @[ task, @(bytesOf(task)) ];
      }
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, waitMs * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      [session getAllTasksWithCompletionHandler:^(NSArray<__kindof NSURLSessionTask *> *now) {
        // Progress: the link is slow, not stalled.
        BOOL renewed = !progressed(before, now, host) && [self renewSessionOf:handler ifStill:session];
        if (done != nil) {
          done(renewed);
        }
      }];
    });
  }];
  return YES;
}

/** `host`: TeamStation's API host, whose requests' progress says the link works. */
RCT_EXPORT_METHOD(renew : (NSString *)host resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  static BOOL warned = NO;
  id handler = [RCTConnections handlerOfNetworking:[_moduleRegistry moduleForName:"Networking"]];
  BOOL reached = [RCTConnections renewSessionOf:handler
                                        forHost:host.length > 0 ? host : nil
                                   ifStalledFor:STALL_CHECK_MS
                                           done:^(BOOL renewed) {
                                             resolve(@(renewed));
                                           }];
  if (!reached) {
    if (!warned) {
      warned = YES;
      RCTLogWarn(@"TSConnections: React Native's HTTP session cannot be reached; stalled connections stay");
    }
    resolve(@NO);
  }
}

@end
