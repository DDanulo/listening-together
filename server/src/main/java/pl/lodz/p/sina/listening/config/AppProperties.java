package pl.lodz.p.sina.listening.config;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;

@ConfigurationProperties("app")
public record AppProperties(
		@DefaultValue Playback playback,
		@DefaultValue Ws ws,
		@DefaultValue Storage storage,
		@DefaultValue Log log,
		@DefaultValue Rooms rooms,
		@DefaultValue RateLimits rateLimits) {

	/** @param leadMs how far in the future every playback change is scheduled (protocol §5) */
	public record Playback(@DefaultValue("1000") double leadMs) {
	}

	/**
	 * @param allowedOrigins extra allowed Origin patterns; empty = same-origin only
	 * @param helloTimeoutMs connections that don't send hello within this time are closed
	 * @param sendTimeLimitMs a client that can't take a message for this long is disconnected
	 * @param sendBufferSize messages buffered for a slow client before it is disconnected
	 */
	public record Ws(
			@DefaultValue List<String> allowedOrigins,
			@DefaultValue("10000") long helloTimeoutMs,
			@DefaultValue("5000") int sendTimeLimitMs,
			@DefaultValue("512KB") DataSize sendBufferSize) {
	}

	/**
	 * @param dir where uploaded tracks are stored; blank = a new temp directory
	 * @param maxSize total size of all stored tracks
	 */
	public record Storage(@DefaultValue("") String dir, @DefaultValue("3GB") DataSize maxSize) {
	}

	public record Log(@DefaultValue("logs") String dir) {
	}

	/**
	 * @param idleTimeoutMs a room without members is deleted after this time (also if nobody ever joined)
	 */
	public record Rooms(
			@DefaultValue("600000") long idleTimeoutMs,
			@DefaultValue("500") int maxRooms,
			@DefaultValue("20") int maxMembers,
			@DefaultValue("30") int maxTracks,
			@DefaultValue("200") int maxTitleLength) {
	}

	/**
	 * HTTP limits are per client IP and per 10 minutes; WebSocket limits are per connection.
	 */
	public record RateLimits(
			@DefaultValue("10") int roomsPer10Min,
			@DefaultValue("60") int uploadsPer10Min,
			@DefaultValue("100") int wsBurst,
			@DefaultValue("20") int wsPerSecond) {
	}
}
