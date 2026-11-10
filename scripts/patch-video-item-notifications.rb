# Each player observes its own item's stalls and failures. react-native-video
# registers both notifications for every item (`object: nil`), so on a screen
# of several players one camera's failed item raised an error, and its stall
# a stall, in every player.
def patch_video_item_notifications(root)
  path = File.join(root, 'ios/Video/Features/RCTPlayerObserver.swift')
  source = File.read(path)
  %w[handlePlaybackStalled handleDidFailToFinishPlaying].each do |handler|
    name = handler == 'handlePlaybackStalled' ? 'AVPlayerItemPlaybackStalled' : 'AVPlayerItemFailedToPlayToEndTime'
    head = "selector: #selector(RCTPlayerObserverHandler.#{handler}(notification:)),\n" \
           "                                               name: NSNotification.Name.#{name},\n" \
           '                                               object: '
    after = "#{head}player?.currentItem)"
    next if source.include?(after)
    before = "#{head}nil)"
    raise 'react-native-video item notifications changed; review the observers' unless source.scan(before).length == 1
    source = source.sub(before, after)
  end
  File.write(path, source)
end

patch_video_item_notifications(ARGV.fetch(0)) if $PROGRAM_NAME == __FILE__
