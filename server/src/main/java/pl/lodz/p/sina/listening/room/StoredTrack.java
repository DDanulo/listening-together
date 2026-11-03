package pl.lodz.p.sina.listening.room;

import java.nio.file.Path;

import pl.lodz.p.sina.listening.protocol.Track;

public record StoredTrack(Track track, Path file) {
}
