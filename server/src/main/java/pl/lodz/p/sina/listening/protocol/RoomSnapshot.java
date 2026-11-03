package pl.lodz.p.sina.listening.protocol;

import java.util.List;

public record RoomSnapshot(String roomId, List<Member> members, List<Track> queue, PlaybackState playback) {
}
