package pl.lodz.p.sina.listening.room;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import pl.lodz.p.sina.listening.clock.ServerClock;
import pl.lodz.p.sina.listening.config.AppProperties;
import pl.lodz.p.sina.listening.limit.RateLimiter;
import pl.lodz.p.sina.listening.log.EventLog;
import pl.lodz.p.sina.listening.protocol.ClientMessage;
import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.protocol.MemberSync;
import pl.lodz.p.sina.listening.protocol.PlaybackState;
import pl.lodz.p.sina.listening.protocol.PlaybackStatus;
import pl.lodz.p.sina.listening.protocol.ServerMessage;
import pl.lodz.p.sina.listening.storage.TrackStorage;
import pl.lodz.p.sina.listening.ws.MessageSender;

import static pl.lodz.p.sina.listening.log.EventLog.fields;

/**
 * Applies changes to rooms and broadcasts them. Every method locks the room, so changes are serialized per room
 * and broadcasts go out in {@code rev} order.
 */
@Service
public class RoomService {

	static final double MEMBERS_BROADCAST_INTERVAL_MS = 2000;
	static final long SWEEP_INTERVAL_SECONDS = 30;
	static final int MAX_LABEL_LENGTH = 16;

	private static final Logger log = LoggerFactory.getLogger(RoomService.class);

	private final ServerClock clock;
	private final IdGenerator ids;
	private final MessageSender sender;
	private final EventLog events;
	private final RoomRegistry rooms;
	private final TrackStorage storage;
	private final RateLimiter rateLimiter;
	private final ScheduledExecutorService scheduler;
	private final ExecutorService fileIo;
	private final double leadMs;
	private final AppProperties.Rooms limits;

	public RoomService(ServerClock clock, IdGenerator ids, MessageSender sender, EventLog events, RoomRegistry rooms,
			TrackStorage storage, RateLimiter rateLimiter, ScheduledExecutorService roomTimers,
			ExecutorService fileIo, AppProperties properties) {
		this.clock = clock;
		this.ids = ids;
		this.sender = sender;
		this.events = events;
		this.rooms = rooms;
		this.storage = storage;
		this.rateLimiter = rateLimiter;
		this.scheduler = roomTimers;
		this.fileIo = fileIo;
		this.leadMs = properties.playback().leadMs();
		this.limits = properties.rooms();
		scheduler.scheduleWithFixedDelay(this::sweepIdleRooms, SWEEP_INTERVAL_SECONDS, SWEEP_INTERVAL_SECONDS,
				TimeUnit.SECONDS);
	}

	/** Result of a {@code hello}: the member, and the connection it replaced (to be closed), if any. */
	public record Joined(MemberState member, WebSocketSession replaced) {
	}

	/**
	 * Joins a new member, or gives a returning client (same {@code clientId}) its member back (protocol §3.2).
	 *
	 * @throws CommandException {@code ROOM_FULL} if the room has the maximum number of members, or
	 *         {@code ROOM_NOT_FOUND} if it was deleted in the meantime
	 */
	public Joined join(Room room, WebSocketSession session, String name, String clientId) {
		synchronized (room) {
			if (room.closed) {
				throw new CommandException(ErrorCode.ROOM_NOT_FOUND, "Room not found");
			}
			MemberState existing = room.findByClientId(clientId).orElse(null);
			if (existing != null) {
				// A stale socket (e.g. half-open after a network switch) may still look connected: the new one wins.
				boolean wasConnected = existing.connected();
				double gapMs = wasConnected ? 0 : clock.nowMs() - existing.disconnectedAt();
				WebSocketSession previous = existing.reconnect(session, name);
				welcome(room, existing);
				events.log("reconnect", room.id(), existing.memberId(), fields(
						"gapMs", gapMs,
						"replacedOpenConnection", wasConnected));
				return new Joined(existing, previous == session ? null : previous);
			}
			if (room.members.size() >= limits.maxMembers()) {
				throw new CommandException(ErrorCode.ROOM_FULL, "The room is full (" + limits.maxMembers() + " listeners)");
			}
			MemberState member = new MemberState(ids.memberId(), clientId, name, session);
			room.members.put(member.memberId(), member);
			welcome(room, member);
			events.log("join", room.id(), member.memberId(), fields("name", name));
			return new Joined(member, null);
		}
	}

	/**
	 * Handles a closed connection. A user who left on purpose ({@code intentional}, close code 1000) is removed at
	 * once; otherwise the member stays, marked disconnected, for the reconnect grace period. Idempotent, and a
	 * close of a connection that was already replaced by a reconnect is ignored.
	 */
	public void leave(Room room, MemberState member, WebSocketSession session, boolean intentional) {
		synchronized (room) {
			if (room.members.get(member.memberId()) != member || member.session() != session) {
				return;
			}
			if (intentional) {
				removeMember(room, member, "left");
				return;
			}
			if (!member.connected()) {
				return;
			}
			double now = clock.nowMs();
			member.disconnect(now, scheduler.schedule(() -> {
				synchronized (room) {
					// Still the same, still disconnected: it didn't come back in time.
					if (room.members.get(member.memberId()) == member && !member.connected()) {
						removeMember(room, member, "reconnectTimeout");
					}
				}
			}, limits.reconnectGraceMs(), TimeUnit.MILLISECONDS));
			if (!room.hasConnectedMembers()) {
				room.emptySince = now;
			}
			broadcastMembers(room);
			events.log("disconnect", room.id(), member.memberId(), fields());
		}
	}

	private void welcome(Room room, MemberState member) {
		sender.send(member.session(), new ServerMessage.Welcome(ServerMessage.PROTOCOL_VERSION, member.memberId(),
				clock.nowMs(), room.snapshot()));
		broadcastMembers(room);
	}

	private void removeMember(Room room, MemberState member, String reason) {
		member.cancelRemoval();
		room.members.remove(member.memberId());
		if (!room.hasConnectedMembers() && member.connected()) {
			// The last connected member left; if it was already disconnected, emptySince was set back then.
			room.emptySince = clock.nowMs();
		}
		broadcastMembers(room);
		events.log("leave", room.id(), member.memberId(), fields("reason", reason));
	}

	public void command(Room room, MemberState member, ClientMessage.Command command) {
		List<StoredTrack> removed = new ArrayList<>();
		synchronized (room) {
			PlaybackState current = room.playback;
			PlaybackState next = PlaybackTransitions.apply(command.action(), command.position(), command.trackId(),
					current, room.tracks(), clock.nowMs(), leadMs);
			if ("remove".equals(command.action())) {
				room.queue.removeIf(t -> t.track().trackId().equals(command.trackId()) && removed.add(t));
				room.members.values().forEach(m -> m.removeDownload(command.trackId()));
				broadcast(room, new ServerMessage.Queue(room.tracks()));
			}
			if (next != current) {
				setPlayback(room, next, new ServerMessage.Cause(command.action(), member.memberId()));
			}
		}
		// Not on this (WebSocket) thread: a slow delete would delay this client's pongs. Downloads in progress keep
		// their open file handle.
		removed.forEach(t -> fileIo.execute(() -> storage.delete(t.file(), t.track().sizeBytes())));
	}

	/**
	 * Adds an uploaded track to the queue.
	 *
	 * @throws CommandException {@code QUEUE_FULL} or {@code ROOM_NOT_FOUND}; the caller then deletes the file
	 */
	public void addTrack(Room room, StoredTrack track) {
		synchronized (room) {
			if (room.closed) {
				throw new CommandException(ErrorCode.ROOM_NOT_FOUND, "Room not found");
			}
			if (room.queue.size() >= limits.maxTracks()) {
				throw new CommandException(ErrorCode.QUEUE_FULL, "The queue is full (" + limits.maxTracks() + " tracks)");
			}
			room.queue.add(track);
			broadcast(room, new ServerMessage.Queue(room.tracks()));
		}
	}

	/** Deletes rooms that have had no connected members for the idle timeout, with their files (protocol §2). */
	public void sweepIdleRooms() {
		try {
			double now = clock.nowMs();
			for (Room room : rooms.all()) {
				List<StoredTrack> files;
				synchronized (room) {
					if (room.hasConnectedMembers() || now - room.emptySince < limits.idleTimeoutMs()) {
						continue;
					}
					room.closed = true;
					room.members.values().forEach(MemberState::cancelRemoval);
					if (room.autoAdvanceTask != null) {
						room.autoAdvanceTask.cancel(false);
					}
					if (room.pendingMembersBroadcast != null) {
						room.pendingMembersBroadcast.cancel(false);
					}
					files = List.copyOf(room.queue);
					room.queue.clear();
				}
				rooms.remove(room);
				fileIo.execute(() -> {
					files.forEach(t -> storage.delete(t.file(), t.track().sizeBytes()));
					storage.deleteRoomDir(room.id());
				});
				events.log("roomDeleted", room.id(), null, fields("tracks", files.size()));
			}
			rateLimiter.prune();
		}
		catch (RuntimeException e) {
			// An exception would cancel the periodic task for good.
			log.error("Room cleanup failed", e);
		}
	}

	public void trackStatus(Room room, MemberState member, ClientMessage.TrackStatus status) {
		if (status.trackId() == null || status.status() == null) {
			throw new CommandException(ErrorCode.BAD_MESSAGE, "trackStatus needs trackId and status");
		}
		synchronized (room) {
			if (room.findTrack(status.trackId()).isEmpty()) {
				throw new CommandException(ErrorCode.TRACK_NOT_FOUND, "No track with id " + status.trackId());
			}
			member.setDownload(status.trackId(), status.status());
			broadcastMembers(room);
		}
	}

	public void stats(Room room, MemberState member, ClientMessage.Stats stats) {
		if (stats.offsetMs() == null || stats.rttMs() == null) {
			throw new CommandException(ErrorCode.BAD_MESSAGE, "stats needs offsetMs and rttMs");
		}
		events.log("stats", room.id(), member.memberId(), fields(
				"offsetMs", stats.offsetMs(),
				"rttMs", stats.rttMs(),
				"driftMs", stats.driftMs(),
				"outputLatencyMs", stats.outputLatencyMs(),
				"outputDelayMs", stats.outputDelayMs(),
				"clockStrategy", label(stats.clockStrategy()),
				"driftStrategy", label(stats.driftStrategy()),
				"naive", stats.naive(),
				"playbackRate", stats.playbackRate(),
				"resyncs", stats.resyncs(),
				"skewPpm", stats.skewPpm(),
				"syncedAfterMs", stats.syncedAfterMs(),
				"reconnects", stats.reconnects(),
				"lastOutageMs", stats.lastOutageMs(),
				"evalChannel", label(stats.evalChannel())));
		synchronized (room) {
			member.setSync(new MemberSync(stats.offsetMs(), stats.rttMs(), stats.driftMs()));
			broadcastMembersThrottled(room);
		}
	}

	/** Client-chosen strings end up in the log: keep them short. */
	private static String label(String value) {
		return value == null || value.length() <= MAX_LABEL_LENGTH ? value : value.substring(0, MAX_LABEL_LENGTH);
	}

	private void setPlayback(Room room, PlaybackState state, ServerMessage.Cause cause) {
		room.playback = state;
		broadcast(room, new ServerMessage.Playback(state, cause));
		events.log("playback", room.id(), cause == null ? null : cause.memberId(), fields(
				"action", cause == null ? "auto-advance" : cause.action(),
				"rev", state.rev(),
				"status", state.status(),
				"trackId", state.trackId(),
				"position", state.position(),
				"effectiveAt", state.effectiveAt()));
		scheduleAutoAdvance(room);
	}

	/**
	 * Broadcasts the next track {@code leadMs} before the current one ends, with {@code effectiveAt} = the end,
	 * so clients can schedule a gapless transition (protocol §5).
	 */
	private void scheduleAutoAdvance(Room room) {
		if (room.autoAdvanceTask != null) {
			room.autoAdvanceTask.cancel(false);
			room.autoAdvanceTask = null;
		}
		PlaybackState state = room.playback;
		if (state.status() != PlaybackStatus.PLAYING) {
			return;
		}
		double fireAt = PlaybackTransitions.endAt(state, room.tracks()) - leadMs;
		long delayMs = Math.max(0, (long) Math.ceil(fireAt - clock.nowMs()));
		room.autoAdvanceTask = scheduler.schedule(() -> {
			synchronized (room) {
				// A newer state may have replaced the one this timer was scheduled for.
				if (room.playback.rev() == state.rev()) {
					setPlayback(room, PlaybackTransitions.autoAdvance(state, room.tracks()), null);
				}
			}
		}, delayMs, TimeUnit.MILLISECONDS);
	}

	private void broadcastMembersThrottled(Room room) {
		if (room.pendingMembersBroadcast != null) {
			return;
		}
		double waitMs = room.lastMembersBroadcastAt + MEMBERS_BROADCAST_INTERVAL_MS - clock.nowMs();
		if (waitMs <= 0) {
			broadcastMembers(room);
			return;
		}
		room.pendingMembersBroadcast = scheduler.schedule(() -> {
			synchronized (room) {
				room.pendingMembersBroadcast = null;
				broadcastMembers(room);
			}
		}, (long) Math.ceil(waitMs), TimeUnit.MILLISECONDS);
	}

	private void broadcastMembers(Room room) {
		room.lastMembersBroadcastAt = clock.nowMs();
		broadcast(room, new ServerMessage.Members(room.memberViews()));
	}

	private void broadcast(Room room, ServerMessage message) {
		TextMessage encoded = sender.encode(message);
		for (MemberState member : List.copyOf(room.members.values())) {
			// A disconnected member's socket is closed; it gets the full state in welcome when it returns.
			if (member.connected()) {
				sender.send(member.session(), encoded);
			}
		}
	}

}
