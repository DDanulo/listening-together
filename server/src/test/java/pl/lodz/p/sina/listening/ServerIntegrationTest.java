package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		// small limits so the 413 test doesn't need a 50 MB body
		"spring.servlet.multipart.max-file-size=1KB",
		"spring.servlet.multipart.max-request-size=2KB",
		"app.log.dir=target/test-logs",
		// these tests create many rooms from one IP; LimitsIntegrationTest covers the limits
		"app.rate-limits.roomsPer10Min=1000",
		"app.rate-limits.uploadsPer10Min=1000",
})
class ServerIntegrationTest {

	private static final String IP = "203.0.113.1";

	@LocalServerPort
	int port;

	@Autowired
	JsonMapper mapper;

	private TestApi api;

	@BeforeEach
	void setUp() {
		api = new TestApi(port, mapper);
	}

	// ---------- HTTP (T2, T13, T14) ----------

	@Test
	void createAndGetRoom() throws Exception {
		String roomId = api.newRoom(IP);

		HttpResponse<String> response = api.get("/api/rooms/" + roomId);
		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(api.json(response).get("memberCount").asInt()).isZero();
	}

	@Test
	void unknownRoomIs404() throws Exception {
		HttpResponse<String> response = api.get("/api/rooms/nope42");

		assertThat(response.statusCode()).isEqualTo(404);
		assertThat(api.json(response).get("code").asString()).isEqualTo("ROOM_NOT_FOUND");
	}

	@Test
	void uploadBroadcastsQueueAndFileCanBeDownloadedSafely() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			HttpResponse<String> upload = api.upload(roomId, alice.memberId(), "song.mp3", "audio/mpeg",
					TestApi.mp3(300), IP);

			assertThat(upload.statusCode()).isEqualTo(201);
			JsonNode track = api.json(upload);
			assertThat(track.get("title").asString()).isEqualTo("song");
			assertThat(track.get("durationMs").asDouble()).isEqualTo(123_000);

			JsonNode queue = alice.next("queue");
			assertThat(queue.get("tracks").get(0).get("trackId").asString())
					.isEqualTo(track.get("trackId").asString());

			HttpResponse<byte[]> file = api.download(track.get("url").asString());
			assertThat(file.statusCode()).isEqualTo(200);
			assertThat(file.body()).hasSize(300);
			assertThat(file.headers().firstValue("Content-Type")).hasValue("audio/mpeg");
			assertThat(file.headers().firstValue("Content-Length")).hasValue("300");
			assertThat(file.headers().firstValue("Cache-Control").orElse(""))
					.contains("private", "max-age=86400", "immutable");
			assertThat(file.headers().firstValue("X-Content-Type-Options")).hasValue("nosniff");
			assertThat(file.headers().firstValue("Content-Disposition").orElse("")).startsWith("attachment");
		}
	}

	@Test
	void typeComesFromContentNotFromClaims() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			// a FLAC file sent with a generic type and a misleading name
			HttpResponse<String> upload = api.upload(roomId, alice.memberId(), "a.mp3", "application/octet-stream",
					TestApi.startingWith("fLaC", 10), IP);

			assertThat(upload.statusCode()).isEqualTo(201);
			assertThat(api.json(upload).get("mimeType").asString()).isEqualTo("audio/flac");
		}
	}

	@Test
	void nonAudioIs415EvenWithAudioNameAndType() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			for (byte[] content : new byte[][] { TestApi.startingWith("PK\u0003\u0004", 20),
					TestApi.startingWith("%PDF-1.7", 20), TestApi.startingWith("<html>", 20) }) {
				HttpResponse<String> upload = api.upload(roomId, alice.memberId(), "song.mp3", "audio/mpeg", content,
						IP);

				assertThat(upload.statusCode()).isEqualTo(415);
				assertThat(api.json(upload).get("code").asString()).isEqualTo("UNSUPPORTED_MEDIA_TYPE");
			}
		}
	}

	@Test
	void tooLargeUploadIs413() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			HttpResponse<String> upload = api.upload(roomId, alice.memberId(), "big.mp3", "audio/mpeg",
					TestApi.mp3(1500), IP);

			assertThat(upload.statusCode()).isEqualTo(413);
			assertThat(api.json(upload).get("code").asString()).isEqualTo("FILE_TOO_LARGE");
		}
	}

	@Test
	void removedTrackCanNoLongerBeDownloaded() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			JsonNode track = api.json(api.upload(roomId, alice.memberId(), "song.mp3", "audio/mpeg",
					TestApi.mp3(100), IP));
			alice.next("queue");

			alice.send("{\"type\":\"command\",\"action\":\"remove\",\"trackId\":\""
					+ track.get("trackId").asString() + "\"}");

			assertThat(alice.next("queue").get("tracks")).isEmpty();
			assertThat(api.download(track.get("url").asString()).statusCode()).isEqualTo(404);
		}
	}

	// ---------- WebSocket (T10–T12) ----------

	@Test
	void unknownRoomClosesWith4404() {
		try (WsTestClient client = WsTestClient.connect(port, "nope42", mapper)) {
			assertThat(client.next("error").get("code").asString()).isEqualTo("ROOM_NOT_FOUND");
			assertThat(client.awaitCloseCode()).isEqualTo(4404);
		}
	}

	@Test
	void messageBeforeHelloIsBadMessage() throws Exception {
		try (WsTestClient client = WsTestClient.connect(port, api.newRoom(IP), mapper)) {
			client.send("{\"type\":\"ping\",\"seq\":1,\"t0\":1.5}");

			assertThat(client.next("error").get("code").asString()).isEqualTo("BAD_MESSAGE");
		}
	}

	@Test
	void unsupportedVersionClosesWith4400() throws Exception {
		try (WsTestClient client = WsTestClient.connect(port, api.newRoom(IP), mapper)) {
			client.send("{\"type\":\"hello\",\"protocolVersion\":2,\"clientId\":\"c\",\"name\":\"x\"}");

			assertThat(client.next("error").get("code").asString()).isEqualTo("UNSUPPORTED_VERSION");
			assertThat(client.awaitCloseCode()).isEqualTo(4400);
		}
	}

	@Test
	void unknownTypeAndMalformedJsonAreBadMessage() throws Exception {
		try (WsTestClient client = WsTestClient.join(port, api.newRoom(IP), "alice", mapper)) {
			client.send("{\"type\":\"dance\"}");
			assertThat(client.next("error").get("code").asString()).isEqualTo("BAD_MESSAGE");

			client.send("not json");
			assertThat(client.next("error").get("code").asString()).isEqualTo("BAD_MESSAGE");
		}
	}

	@Test
	void welcomeContainsSnapshotWithSelf() throws Exception {
		try (WsTestClient alice = WsTestClient.join(port, api.newRoom(IP), "alice", mapper)) {
			JsonNode room = alice.welcome.get("room");

			assertThat(alice.welcome.get("protocolVersion").asInt()).isEqualTo(1);
			assertThat(room.get("members").get(0).get("memberId").asString()).isEqualTo(alice.memberId());
			assertThat(room.get("playback").get("status").asString()).isEqualTo("stopped");
		}
	}

	@Test
	void pongEchoesPingAndTimestampsAreOrdered() throws Exception {
		try (WsTestClient alice = WsTestClient.join(port, api.newRoom(IP), "alice", mapper)) {
			alice.send("{\"type\":\"ping\",\"seq\":17,\"t0\":48211.305}");

			JsonNode pong = alice.next("pong");
			assertThat(pong.get("seq").asLong()).isEqualTo(17);
			assertThat(pong.get("t0").asDouble()).isEqualTo(48211.305);
			assertThat(pong.get("t1").asDouble()).isLessThanOrEqualTo(pong.get("t2").asDouble());
		}
	}

	@Test
	void commandIsBroadcastToAllMembersIncludingSender() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper);
				WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper)) {
			api.upload(roomId, alice.memberId(), "song.mp3", "audio/mpeg", TestApi.mp3(10), IP);
			alice.next("queue");

			alice.send("{\"type\":\"command\",\"action\":\"play\"}");

			JsonNode toAlice = alice.next("playback");
			JsonNode toBob = bob.next("playback");
			assertThat(toAlice).isEqualTo(toBob);
			assertThat(toAlice.get("state").get("rev").asLong()).isEqualTo(1);
			assertThat(toAlice.get("state").get("status").asString()).isEqualTo("playing");
			assertThat(toAlice.get("cause").get("memberId").asString()).isEqualTo(alice.memberId());
		}
	}

	@Test
	void invalidCommandIsReportedToSenderOnly() throws Exception {
		try (WsTestClient alice = WsTestClient.join(port, api.newRoom(IP), "alice", mapper)) {
			alice.send("{\"type\":\"command\",\"action\":\"pause\"}");

			JsonNode error = alice.next("error");
			assertThat(error.get("code").asString()).isEqualTo("INVALID_COMMAND");
			assertThat(error.get("ref").asString()).isEqualTo("command");
		}
	}

	@Test
	void membersListUpdatesOnJoinAndLeave() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient alice = WsTestClient.join(port, roomId, "alice", mapper)) {
			assertThat(alice.next("members").get("members")).hasSize(1); // broadcast of alice's own join
			try (WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper)) {
				assertThat(alice.next("members").get("members")).hasSize(2);
			}
			assertThat(alice.next("members").get("members")).hasSize(1);
		}
	}
}
