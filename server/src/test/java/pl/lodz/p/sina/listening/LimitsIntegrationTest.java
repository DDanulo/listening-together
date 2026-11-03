package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import pl.lodz.p.sina.listening.room.RoomService;
import pl.lodz.p.sina.listening.storage.TrackStorage;
import tools.jackson.databind.json.JsonMapper;

/** Abuse protection, with tiny limits so they're quick to hit. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.log.dir=target/test-logs",
		"app.rooms.max-members=2",
		"app.rooms.max-tracks=1",
		"app.rooms.idle-timeout-ms=200",
		"app.storage.max-size=1000B",
		"app.rate-limits.roomsPer10Min=3",
		"app.rate-limits.uploadsPer10Min=3",
		"app.rate-limits.ws-burst=20",
		"app.rate-limits.ws-per-second=1",
		"app.ws.hello-timeout-ms=300",
})
class LimitsIntegrationTest {

	/** Each test gets its own client IP, so rate limits don't leak between tests. */
	private static final AtomicInteger NEXT_IP = new AtomicInteger(1);

	@LocalServerPort
	int port;

	@Autowired
	JsonMapper mapper;

	@Autowired
	RoomService roomService;

	@Autowired
	TrackStorage storage;

	private TestApi api;
	private String ip;

	@BeforeEach
	void setUp() {
		api = new TestApi(port, mapper);
		ip = "198.51.100." + NEXT_IP.getAndIncrement();
	}

	@Test
	void roomCreationIsRateLimitedPerClientIp() throws Exception {
		for (int i = 0; i < 3; i++) {
			assertThat(api.createRoom(ip).statusCode()).isEqualTo(201);
		}
		HttpResponse<String> limited = api.createRoom(ip);

		assertThat(limited.statusCode()).isEqualTo(429);
		assertThat(api.json(limited).get("code").asString()).isEqualTo("RATE_LIMITED");
		// another client is not affected
		assertThat(api.createRoom("192.0.2.77").statusCode()).isEqualTo(201);
	}

	@Test
	void uploadsAreRateLimitedPerClientIp() throws Exception {
		String roomId = api.newRoom(ip);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			// with max-tracks=1 only the first one fits; the point is the 4th request is refused before anything else
			for (int i = 0; i < 3; i++) {
				api.upload(roomId, alice.memberId(), "a.mp3", "audio/mpeg", TestApi.mp3(10), ip);
			}
			HttpResponse<String> limited = api.upload(roomId, alice.memberId(), "a.mp3", "audio/mpeg",
					TestApi.mp3(10), ip);

			assertThat(limited.statusCode()).isEqualTo(429);
		}
	}

	@Test
	void fullRoomRefusesJoinWith4409() throws Exception {
		String roomId = api.newRoom(ip);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper);
				WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper);
				WsTestClient carol = WsTestClient.connect(port, roomId, mapper)) {
			carol.send("{\"type\":\"hello\",\"protocolVersion\":1,\"clientId\":\"c\",\"name\":\"carol\"}");

			assertThat(carol.next("error").get("code").asString()).isEqualTo("ROOM_FULL");
			assertThat(carol.awaitCloseCode()).isEqualTo(4409);
		}
	}

	@Test
	void fullQueueRefusesUploadWith409() throws Exception {
		String roomId = api.newRoom(ip);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			long usedBefore = storage.usedBytes();
			assertThat(api.upload(roomId, alice.memberId(), "a.mp3", "audio/mpeg", TestApi.mp3(10), ip)
					.statusCode()).isEqualTo(201);

			HttpResponse<String> full = api.upload(roomId, alice.memberId(), "b.mp3", "audio/mpeg",
					TestApi.mp3(10), ip);

			assertThat(full.statusCode()).isEqualTo(409);
			assertThat(api.json(full).get("code").asString()).isEqualTo("QUEUE_FULL");
			assertThat(storage.usedBytes()).isEqualTo(usedBefore + 10);
		}
	}

	@Test
	void storageQuotaRefusesUploadWith507() throws Exception {
		String roomId = api.newRoom(ip);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			int tooBig = (int) (1000 - storage.usedBytes()) + 1;

			HttpResponse<String> full = api.upload(roomId, alice.memberId(), "a.mp3", "audio/mpeg",
					TestApi.mp3(tooBig), ip);

			assertThat(full.statusCode()).isEqualTo(507);
			assertThat(api.json(full).get("code").asString()).isEqualTo("STORAGE_FULL");
		}
	}

	@Test
	void messageFloodClosesWith4429() throws Exception {
		try (WsTestClient alice = WsTestClient.join(port, api.newRoom(ip), "alice", mapper)) {
			for (int i = 0; i < 30; i++) {
				alice.send("{\"type\":\"ping\",\"seq\":" + i + ",\"t0\":1}");
			}

			assertThat(alice.next("error").get("code").asString()).isEqualTo("RATE_LIMITED");
			assertThat(alice.awaitCloseCode()).isEqualTo(4429);
		}
	}

	@Test
	void connectionWithoutHelloIsClosed() throws Exception {
		try (WsTestClient client = WsTestClient.connect(port, api.newRoom(ip), mapper)) {
			assertThat(client.awaitCloseCode()).isEqualTo(4400);
		}
	}

	@Test
	void idleRoomIsDeletedWithItsFiles() throws Exception {
		// rooms left by earlier tests would be swept below too and change the storage numbers
		Thread.sleep(400);
		roomService.sweepIdleRooms();
		String roomId = api.newRoom(ip);
		long usedBefore = storage.usedBytes();
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			assertThat(api.upload(roomId, alice.memberId(), "a.mp3", "audio/mpeg", TestApi.mp3(50), ip)
					.statusCode()).isEqualTo(201);
			roomService.sweepIdleRooms();
			assertThat(api.get("/api/rooms/" + roomId).statusCode()).isEqualTo(200); // occupied: kept
		}
		Thread.sleep(400); // > idle timeout after alice left

		roomService.sweepIdleRooms();

		assertThat(api.get("/api/rooms/" + roomId).statusCode()).isEqualTo(404);
		// files are deleted in the background (file-io thread)
		long deadline = System.nanoTime() + 2_000_000_000L;
		while (storage.usedBytes() != usedBefore && System.nanoTime() < deadline) {
			Thread.sleep(20);
		}
		assertThat(storage.usedBytes()).isEqualTo(usedBefore);
	}

	@Test
	void roomNobodyJoinsIsDeletedToo() throws Exception {
		String roomId = api.newRoom(ip);
		Thread.sleep(400);

		roomService.sweepIdleRooms();

		assertThat(api.get("/api/rooms/" + roomId).statusCode()).isEqualTo(404);
	}
}
