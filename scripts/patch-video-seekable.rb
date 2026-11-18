# AVPlayer's seekableDuration is a length, not the end of a sliding live range.
# Emit the native range endpoints separately; Android retains its zero-based range.
def patch_video_seekable(root)
  replacements = {
    'ios/Video/RCTVideo.swift' => [
      '"seekableDuration": RCTVideoUtils.calculateSeekableDuration(_player),',
      '"seekableDuration": RCTVideoUtils.calculateSeekableDuration(_player),' + "\n" +
      '                "seekableStart": CMTimeGetSeconds(RCTVideoUtils.playerItemSeekableTimeRange(_player).start),' + "\n" +
      '                "seekableEnd": CMTimeGetSeconds(CMTimeRangeGetEnd(RCTVideoUtils.playerItemSeekableTimeRange(_player))),'
    ],
    'src/specs/VideoNativeComponent.ts' => [
      '  seekableDuration: Float;',
      "  seekableDuration: Float;\n  seekableStart?: Float;\n  seekableEnd?: Float;"
    ]
  }
  replacements.each do |relative, (before, after)|
    path = File.join(root, relative)
    source = File.read(path)
    next if source.include?(after)
    raise 'react-native-video progress implementation changed; review seekable bounds' unless source.scan(before).length == 1
    File.write(path, source.sub(before, after))
  end
end

patch_video_seekable(ARGV.fetch(0)) if $PROGRAM_NAME == __FILE__
