package pl.lodz.p.sina.listening.protocol;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Messages from client to server (protocol §6.1). Fields are boxed so missing values can be detected.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
		@JsonSubTypes.Type(value = ClientMessage.Hello.class, name = "hello"),
		@JsonSubTypes.Type(value = ClientMessage.Ping.class, name = "ping"),
		@JsonSubTypes.Type(value = ClientMessage.Command.class, name = "command"),
		@JsonSubTypes.Type(value = ClientMessage.TrackStatus.class, name = "trackStatus"),
		@JsonSubTypes.Type(value = ClientMessage.Stats.class, name = "stats"),
})
public sealed interface ClientMessage {

	record Hello(Integer protocolVersion, String clientId, String name) implements ClientMessage {
	}

	record Ping(Long seq, Double t0) implements ClientMessage {
	}

	/** One flat record for all actions; which optional fields are required depends on {@code action}. */
	record Command(String action, Double position, String trackId) implements ClientMessage {
	}

	record TrackStatus(String trackId, DownloadStatus status) implements ClientMessage {
	}

	/** The fields after {@code outputLatencyMs} are optional and only logged, for the evaluation (protocol §6.1). */
	record Stats(Double offsetMs, Double rttMs, Double driftMs, Double outputLatencyMs, String clockStrategy,
			String driftStrategy, Boolean naive, Double playbackRate, Integer resyncs, Double skewPpm,
			Double syncedAfterMs, Integer reconnects, Double lastOutageMs, String evalChannel) implements ClientMessage {
	}
}
