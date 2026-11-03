package pl.lodz.p.sina.listening.protocol;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Messages from server to client (protocol §6.2). Serialize with {@code writerFor(ServerMessage.class)} so the
 * {@code type} property is always written.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
		@JsonSubTypes.Type(value = ServerMessage.Welcome.class, name = "welcome"),
		@JsonSubTypes.Type(value = ServerMessage.Pong.class, name = "pong"),
		@JsonSubTypes.Type(value = ServerMessage.Members.class, name = "members"),
		@JsonSubTypes.Type(value = ServerMessage.Queue.class, name = "queue"),
		@JsonSubTypes.Type(value = ServerMessage.Playback.class, name = "playback"),
		@JsonSubTypes.Type(value = ServerMessage.ErrorReply.class, name = "error"),
})
public sealed interface ServerMessage {

	int PROTOCOL_VERSION = 1;

	record Welcome(int protocolVersion, String memberId, double serverTime, RoomSnapshot room)
			implements ServerMessage {
	}

	record Pong(long seq, double t0, double t1, double t2) implements ServerMessage {
	}

	record Members(List<Member> members) implements ServerMessage {
	}

	record Queue(List<Track> tracks) implements ServerMessage {
	}

	/** @param cause null for server-initiated changes (auto-advance) */
	record Playback(PlaybackState state, Cause cause) implements ServerMessage {
	}

	record Cause(String action, String memberId) {
	}

	/** @param ref type of the message that caused the error, or null */
	record ErrorReply(ErrorCode code, String message, String ref) implements ServerMessage {
	}
}
