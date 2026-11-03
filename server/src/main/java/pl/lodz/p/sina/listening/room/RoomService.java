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

	/**
	 * @throws CommandException {@code ROOM_FULL} if the room has the maximum number of members, or
	 *         {@code ROOM_NOT_FOUND} if it was deleted in the meantime
	 */
	public MemberState join(Room room, WebSocketSession session, String name) {
		synchronized (room) {
			if (room.closed) {
				throw new CommandException(ErrorCode.ROOM_NOT_FOUND, "Room not found");
			}
			if (room.members.size() >= limits.maxMembers()) {
				throw new CommandException(ErrorCode.ROOM_FULL, "The room is full (" + limits.maxMembers() + " listeners)");
			}
			MemberState member = new MemberState(ids.memberId(), name, session);
			room.members.put(member.memberId(), member);
			sender.send(session, new ServerMessage.Welcome(ServerMessage.PROTOCOL_VERSION, member.memberId(),
					clock.nowMs(), room.snapshot()));
			broadcastMembers(room);
			events.log("join", room.id(), member.memberId(), fields("name", name));
			return member;
		}
	}

	public void leave(Room room, MemberState member) {
		synchronized (room) {
			// PoC: no reconnect grace period; a returning client joins as a new member (protocol §3.2 later).
			if (room.members.remove(member.memberId()) != null) {
				if (room.members.isEmpty()) {
					room.emptySince = clock.nowMs();
				}
				broadcastMembers(room);
				events.log("leave", room.id(), member.memberId(), fields());
			}
		}
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

	/** Deletes rooms that have had no members for the idle timeout, with their files (protocol §2). */
	public void sweepIdleRooms() {
		try {
			double now = clock.nowMs();
			for (Room room : rooms.all()) {
				List<StoredTrack> files;
				synchronized (room) {
					if (!room.members.isEmpty() || now - room.emptySince < limits.idleTimeoutMs()) {
						continue;
					}
					room.closed = true;
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
				"outputLatencyMs", stats.outputLatencyMs()));
		synchronized (room) {
			member.setSync(new MemberSync(stats.offsetMs(), stats.rttMs(), stats.driftMs()));
			broadcastMembersThrottled(room);
		}
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
		List<MemberState> members = List.copyOf(room.members.values());
		for (MemberState member : members) {
			sender.send(member.session(), encoded);
		}
	}

}
