package pl.lodz.p.sina.listening.room;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ScheduledFuture;

import org.springframework.web.socket.WebSocketSession;

import pl.lodz.p.sina.listening.protocol.DownloadStatus;
import pl.lodz.p.sina.listening.protocol.Member;
import pl.lodz.p.sina.listening.protocol.MemberSync;

/**
 * A member of a room, connected or waiting to reconnect (protocol §3.2). Mutable; guarded by the owning
 * {@link Room}'s monitor.
 */
public final class MemberState {

	private final String memberId;
	/** Never broadcast: knowing it is what lets a reconnecting client take this member back. */
	private final String clientId;
	private String name;
	private WebSocketSession session;
	private boolean connected = true;
	/** Server time of the last disconnect; meaningful only while not connected. */
	private double disconnectedAt;
	/** Removes the member if it doesn't come back within the grace period. */
	private ScheduledFuture<?> removal;
	private final Map<String, DownloadStatus> downloads = new LinkedHashMap<>();
	private MemberSync sync;

	MemberState(String memberId, String clientId, String name, WebSocketSession session) {
		this.memberId = memberId;
		this.clientId = clientId;
		this.name = name;
		this.session = session;
	}

	public String memberId() {
		return memberId;
	}

	String clientId() {
		return clientId;
	}

	WebSocketSession session() {
		return session;
	}

	boolean connected() {
		return connected;
	}

	double disconnectedAt() {
		return disconnectedAt;
	}

	/** Attaches a new connection; returns the previous session (it may still be open). */
	WebSocketSession reconnect(WebSocketSession newSession, String newName) {
		WebSocketSession previous = session;
		session = newSession;
		name = newName;
		connected = true;
		cancelRemoval();
		return previous;
	}

	void disconnect(double now, ScheduledFuture<?> removalTask) {
		connected = false;
		disconnectedAt = now;
		cancelRemoval();
		removal = removalTask;
	}

	void cancelRemoval() {
		if (removal != null) {
			removal.cancel(false);
			removal = null;
		}
	}

	void setDownload(String trackId, DownloadStatus status) {
		downloads.put(trackId, status);
	}

	void removeDownload(String trackId) {
		downloads.remove(trackId);
	}

	void setSync(MemberSync sync) {
		this.sync = sync;
	}

	Member toView() {
		return new Member(memberId, name, connected, Collections.unmodifiableMap(new LinkedHashMap<>(downloads)),
				sync);
	}
}
