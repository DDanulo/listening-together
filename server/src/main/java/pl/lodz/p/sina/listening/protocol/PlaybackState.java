package pl.lodz.p.sina.listening.protocol;

/**
 * Authoritative playback state of a room (protocol §5).
 *
 * @param position track position in ms at server time {@code effectiveAt}
 */
public record PlaybackState(long rev, PlaybackStatus status, String trackId, double position, double effectiveAt) {

	public static PlaybackState initial() {
		return new PlaybackState(0, PlaybackStatus.STOPPED, null, 0, 0);
	}
}
