package pl.lodz.p.sina.listening.room;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.web.socket.WebSocketSession;

import pl.lodz.p.sina.listening.protocol.DownloadStatus;
import pl.lodz.p.sina.listening.protocol.Member;
import pl.lodz.p.sina.listening.protocol.MemberSync;

/** A connected member. Mutable; guarded by the owning {@link Room}'s monitor. */
public final class MemberState {

	private final String memberId;
	private final String name;
	private final WebSocketSession session;
	private final Map<String, DownloadStatus> downloads = new LinkedHashMap<>();
	private MemberSync sync;

	MemberState(String memberId, String name, WebSocketSession session) {
		this.memberId = memberId;
		this.name = name;
		this.session = session;
	}

	public String memberId() {
		return memberId;
	}

	WebSocketSession session() {
		return session;
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
		return new Member(memberId, name, true, Collections.unmodifiableMap(new LinkedHashMap<>(downloads)), sync);
	}
}
