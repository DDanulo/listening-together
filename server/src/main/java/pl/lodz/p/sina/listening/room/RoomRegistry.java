package pl.lodz.p.sina.listening.room;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import pl.lodz.p.sina.listening.clock.ServerClock;

/** All rooms, in memory. Idle rooms are deleted by {@link RoomService#sweepIdleRooms()}. */
@Component
public class RoomRegistry {

	private final Map<String, Room> rooms = new ConcurrentHashMap<>();
	private final IdGenerator ids;
	private final ServerClock clock;

	public RoomRegistry(IdGenerator ids, ServerClock clock) {
		this.ids = ids;
		this.clock = clock;
	}

	/** Creates a room unless there are already {@code maxRooms}. Synchronized, so concurrent calls can't overshoot. */
	public synchronized Optional<Room> tryCreate(int maxRooms) {
		if (rooms.size() >= maxRooms) {
			return Optional.empty();
		}
		while (true) {
			Room room = new Room(ids.roomId(), clock.nowMs());
			if (rooms.putIfAbsent(room.id(), room) == null) {
				return Optional.of(room);
			}
		}
	}

	public Optional<Room> find(String roomId) {
		return roomId == null ? Optional.empty() : Optional.ofNullable(rooms.get(roomId));
	}

	public int size() {
		return rooms.size();
	}

	List<Room> all() {
		return new ArrayList<>(rooms.values());
	}

	void remove(Room room) {
		rooms.remove(room.id(), room);
	}
}
