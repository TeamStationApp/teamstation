# The pinned player drops completion for a native no-op seek. JS cannot know
# the exact native position between progress events, so every seek needs an ack.
def patch_video_seek(path)
  source = File.read(path)
  before = "// skip if there is no diff in current time and seek time\n            return"
  after = "// A no-op seek still acknowledges the caller.\n            completion(true)\n            return"
  return if source.include?(after)
  raise 'react-native-video seek implementation changed; review the no-op fix' unless source.scan(before).length == 1
  File.write(path, source.sub(before, after))
end

patch_video_seek(ARGV.fetch(0)) if $PROGRAM_NAME == __FILE__
