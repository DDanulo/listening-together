package pl.lodz.p.sina.listening.ws;

import java.net.URI;
import java.util.Optional;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import pl.lodz.p.sina.listening.clock.ServerClock;
import pl.lodz.p.sina.listening.config.AppProperties;
import pl.lodz.p.sina.listening.limit.TokenBucket;
import pl.lodz.p.sina.listening.protocol.ClientMessage;
import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.protocol.ServerMessage;
import pl.lodz.p.sina.listening.room.CommandException;
import pl.lodz.p.sina.listening.room.MemberState;
import pl.lodz.p.sina.listening.room.Room;
import pl.lodz.p.sina.listening.room.RoomRegistry;
import pl.lodz.p.sina.listening.room.RoomService;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/** WebSocket endpoint {@code /ws/rooms/{roomId}} (protocol §3). */
@Component
public class RoomSocketHandler extends TextWebSocketHandler {

	public static final CloseStatus ROOM_NOT_FOUND = new CloseStatus(4404, "Room not found");
	public static final CloseStatus PROTOCOL_ERROR = new CloseStatus(4400, "Protocol error");
	public static final CloseStatus ROOM_FULL = new CloseStatus(4409, "Room is full");
	public static final CloseStatus RATE_LIMITED = new CloseStatus(4429, "Too many messages");
	static final int MAX_NAME_LENGTH = 32;

	private static final Logger log = LoggerFactory.getLogger(RoomSocketHandler.class);
	private static final String OUT = "out";
	private static final String ROOM = "room";
	private static final String MEMBER = "member";
	private static final String LIMIT = "limit";

	private final ServerClock clock;
	private final JsonMapper mapper;
	private final MessageSender sender;
	private final RoomRegistry rooms;
	private final RoomService roomService;
	private final ScheduledExecutorService timers;
	private final long helloTimeoutMs;
	private final AppProperties.RateLimits limits;
	private final AppProperties.Ws ws;

	public RoomSocketHandler(ServerClock clock, JsonMapper mapper, MessageSender sender, RoomRegistry rooms,
			RoomService roomService, ScheduledExecutorService roomTimers, AppProperties properties) {
		this.clock = clock;
		this.mapper = mapper;
		this.sender = sender;
		this.rooms = rooms;
		this.roomService = roomService;
		this.timers = roomTimers;
		this.helloTimeoutMs = properties.ws().helloTimeoutMs();
		this.limits = properties.rateLimits();
		this.ws = properties.ws();
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) throws Exception {
		// sendMessage isn't thread-safe and broadcasts come from other threads: always send through the decorator.
		WebSocketSession out = new ConcurrentWebSocketSessionDecorator(session, ws.sendTimeLimitMs(),
				(int) ws.sendBufferSize().toBytes());
		session.getAttributes().put(OUT, out);
		Optional<Room> room = rooms.find(roomIdOf(session.getUri()));
		if (room.isEmpty()) {
			sendError(out, ErrorCode.ROOM_NOT_FOUND, "Room not found", null);
			out.close(ROOM_NOT_FOUND);
			return;
		}
		session.getAttributes().put(ROOM, room.get());
		session.getAttributes().put(LIMIT, new TokenBucket(limits.wsBurst(), limits.wsPerSecond() / 1000.0,
				clock.nowMs()));
		// Connections that never say hello only hold resources.
		timers.schedule(() -> {
			if (out.isOpen() && !session.getAttributes().containsKey(MEMBER)) {
				sendError(out, ErrorCode.BAD_MESSAGE, "No hello received", null);
				close(out, PROTOCOL_ERROR);
			}
		}, helloTimeoutMs, TimeUnit.MILLISECONDS);
	}

	@Override
	protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
		// t1 must be taken before anything else, including parsing (protocol §4).
		double t1 = clock.nowMs();
		WebSocketSession out = (WebSocketSession) session.getAttributes().get(OUT);
		Room room = (Room) session.getAttributes().get(ROOM);
		if (room == null) {
			return;
		}
		TokenBucket limit = (TokenBucket) session.getAttributes().get(LIMIT);
		if (!limit.tryTake(t1)) {
			sendError(out, ErrorCode.RATE_LIMITED, "Too many messages", null);
			close(out, RATE_LIMITED);
			return;
		}

		ClientMessage msg;
		try {
			msg = mapper.readValue(message.getPayload(), ClientMessage.class);
		}
		catch (JacksonException e) {
			sendError(out, ErrorCode.BAD_MESSAGE, "Malformed message: " + e.getOriginalMessage(), null);
			return;
		}

		MemberState member = (MemberState) session.getAttributes().get(MEMBER);
		if (member == null) {
			if (msg instanceof ClientMessage.Hello hello) {
				hello(session, out, room, hello);
			}
			else {
				sendError(out, ErrorCode.BAD_MESSAGE, "The first message must be hello", typeOf(msg));
			}
			return;
		}

		try {
			switch (msg) {
				case ClientMessage.Ping ping -> pong(out, ping, t1);
				case ClientMessage.Hello hello -> sendError(out, ErrorCode.BAD_MESSAGE, "Already joined", "hello");
				case ClientMessage.Command command -> roomService.command(room, member, command);
				case ClientMessage.TrackStatus status -> roomService.trackStatus(room, member, status);
				case ClientMessage.Stats stats -> roomService.stats(room, member, stats);
			}
		}
		catch (CommandException e) {
			sendError(out, e.code(), e.getMessage(), typeOf(msg));
		}
	}

	private void hello(WebSocketSession session, WebSocketSession out, Room room, ClientMessage.Hello hello)
			throws Exception {
		if (hello.protocolVersion() == null || hello.protocolVersion() != ServerMessage.PROTOCOL_VERSION) {
			sendError(out, ErrorCode.UNSUPPORTED_VERSION,
					"Server speaks protocol version " + ServerMessage.PROTOCOL_VERSION, "hello");
			out.close(PROTOCOL_ERROR);
			return;
		}
		String name = hello.name() == null ? "" : hello.name().trim();
		if (name.isEmpty() || name.length() > MAX_NAME_LENGTH) {
			sendError(out, ErrorCode.BAD_MESSAGE, "Name must be 1–" + MAX_NAME_LENGTH + " characters", "hello");
			return;
		}
		try {
			MemberState member = roomService.join(room, out, name);
			session.getAttributes().put(MEMBER, member);
			// If the connection closed while joining, afterConnectionClosed may have run before MEMBER was set and
			// skipped leave(): without this, a ghost member would keep the room (and its files) alive forever.
			// leave() is idempotent, so a double call is harmless.
			if (!session.isOpen()) {
				roomService.leave(room, member);
			}
		}
		catch (CommandException e) {
			sendError(out, e.code(), e.getMessage(), "hello");
			close(out, e.code() == ErrorCode.ROOM_FULL ? ROOM_FULL : ROOM_NOT_FOUND);
		}
	}

	private void pong(WebSocketSession out, ClientMessage.Ping ping, double t1) {
		if (ping.seq() == null || ping.t0() == null) {
			sendError(out, ErrorCode.BAD_MESSAGE, "ping needs seq and t0", "ping");
			return;
		}
		// t2 as late as possible: right before handing the frame to the socket.
		sender.send(out, new ServerMessage.Pong(ping.seq(), ping.t0(), t1, clock.nowMs()));
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		Room room = (Room) session.getAttributes().get(ROOM);
		MemberState member = (MemberState) session.getAttributes().get(MEMBER);
		if (room != null && member != null) {
			roomService.leave(room, member);
		}
	}

	@Override
	public void handleTransportError(WebSocketSession session, Throwable exception) {
		log.debug("Transport error on {}: {}", session.getId(), exception.getMessage());
	}

	private static void close(WebSocketSession out, CloseStatus status) {
		try {
			out.close(status);
		}
		catch (Exception e) {
			log.debug("Close failed: {}", e.getMessage());
		}
	}

	private void sendError(WebSocketSession out, ErrorCode code, String message, String ref) {
		sender.send(out, new ServerMessage.ErrorReply(code, message, ref));
	}

	private static String roomIdOf(URI uri) {
		if (uri == null) {
			return null;
		}
		String path = uri.getPath();
		return path.substring(path.lastIndexOf('/') + 1);
	}

	private static String typeOf(ClientMessage msg) {
		return switch (msg) {
			case ClientMessage.Hello h -> "hello";
			case ClientMessage.Ping p -> "ping";
			case ClientMessage.Command c -> "command";
			case ClientMessage.TrackStatus t -> "trackStatus";
			case ClientMessage.Stats s -> "stats";
		};
	}
}
