package pl.lodz.p.sina.listening.api;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import pl.lodz.p.sina.listening.config.AppProperties;
import pl.lodz.p.sina.listening.limit.RateLimiter;
import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.room.Room;
import pl.lodz.p.sina.listening.room.RoomRegistry;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {

	public record CreatedRoom(String roomId) {
	}

	public record RoomInfo(String roomId, int memberCount) {
	}

	private final RoomRegistry rooms;
	private final RateLimiter rateLimiter;
	private final int maxRooms;

	public RoomController(RoomRegistry rooms, RateLimiter rateLimiter, AppProperties properties) {
		this.rooms = rooms;
		this.rateLimiter = rateLimiter;
		this.maxRooms = properties.rooms().maxRooms();
	}

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	CreatedRoom create(HttpServletRequest request) {
		// Checked before the rate limit, so a refusal doesn't cost the client one of its rooms.
		if (rooms.size() >= maxRooms) {
			throw serverBusy();
		}
		// getRemoteAddr is the real client behind Caddy (server.forward-headers-strategy=native).
		if (!rateLimiter.tryAcquire(RateLimiter.Action.CREATE_ROOM, request.getRemoteAddr())) {
			throw ApiException.rateLimited();
		}
		// Only a race with other creators can make this fail after the check above.
		return new CreatedRoom(rooms.tryCreate(maxRooms).orElseThrow(RoomController::serverBusy).id());
	}

	private static ApiException serverBusy() {
		return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVER_BUSY,
				"The server is busy, try again later");
	}

	@GetMapping("/{roomId}")
	RoomInfo get(@PathVariable String roomId) {
		Room room = rooms.find(roomId).orElseThrow(ApiException::roomNotFound);
		return new RoomInfo(room.id(), room.memberCount());
	}
}
