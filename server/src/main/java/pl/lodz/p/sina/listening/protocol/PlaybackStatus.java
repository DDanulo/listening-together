package pl.lodz.p.sina.listening.protocol;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum PlaybackStatus {
	@JsonProperty("playing") PLAYING,
	@JsonProperty("paused") PAUSED,
	@JsonProperty("stopped") STOPPED
}
