package pl.lodz.p.sina.listening.room;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ScheduledFuture;

import pl.lodz.p.sina.listening.protocol.Member;
import pl.lodz.p.sina.listening.protocol.PlaybackState;
import pl.lodz.p.sina.listening.protocol.RoomSnapshot;
import pl.lodz.p.sina.listening.protocol.Track;

/**
 * State of one room. All fields are guarded by this object's monitor: mutate only inside
 * {@code synchronized (room)}, which also keeps broadcasts in {@code rev} order.
 */
public final class Room {

	private final String id;
	final Map<String, MemberState> members = new LinkedHashMap<>();
	final List<StoredTrack> queue = new ArrayList<>();
	PlaybackState playback = PlaybackState.initial();
	ScheduledFuture<?> autoAdvanceTask;
	ScheduledFuture<?> pendingMembersBroadcast;
	double lastMembersBroadcastAt = Double.NEGATIVE_INFINITY;
	/** Server time since which the room has had no members (creation time if nobody joined yet). */
	double emptySince;
	/** Set when the room is deleted; late joins and uploads to it are refused. */
	boolean closed;

	Room(String id, double createdAt) {
		this.id = id;
		this.emptySince = createdAt;
	}

	public String id() {
		return id;
	}

	public synchronized int memberCount() {
		return members.size();
	}

	public synchronized boolean hasMember(String memberId) {
		return members.containsKey(memberId);
	}

	public synchronized int trackCount() {
		return queue.size();
	}

	public synchronized Optional<StoredTrack> findTrack(String trackId) {
		return queue.stream().filter(t -> t.track().trackId().equals(trackId)).findFirst();
	}

	List<Track> tracks() {
		return queue.stream().map(StoredTrack::track).toList();
	}

	List<Member> memberViews() {
		return members.values().stream().map(MemberState::toView).toList();
	}

	RoomSnapshot snapshot() {
		return new RoomSnapshot(id, memberViews(), tracks(), playback);
	}
}
