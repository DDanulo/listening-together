package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import pl.lodz.p.sina.listening.room.RoomService;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Reconnection with the same clientId (protocol §3.2). */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.log.dir=target/test-logs",
		"app.rate-limits.roomsPer10Min=1000",
		"app.rooms.reconnect-grace-ms=600",
		"app.rooms.idle-timeout-ms=300",
})
class ReconnectIntegrationTest {

	private static final String IP = "203.0.113.9";

	@LocalServerPort
	int port;

	@Autowired
	JsonMapper mapper;

	@Autowired
	RoomService roomService;

	private TestApi api;

	@BeforeEach
	void setUp() {
		api = new TestApi(port, mapper);
	}

	@Test
	void reconnectWithSameClientIdKeepsTheMember() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper)) {
			WsTestClient alice = WsTestClient.join(port, roomId, "alice", "client-a", mapper);
			String aliceId = alice.memberId();

			alice.abort();
			JsonNode afterDrop = nextMembers(bob, m -> disconnected(m, aliceId));
			assertThat(afterDrop.get("members")).hasSize(2); // still there, waiting to come back

			try (WsTestClient aliceAgain = WsTestClient.join(port, roomId, "alice", "client-a", mapper)) {
				assertThat(aliceAgain.memberId()).isEqualTo(aliceId);
				JsonNode afterReturn = nextMembers(bob, m -> connected(m, aliceId));
				assertThat(afterReturn.get("members")).hasSize(2);
			}
		}
	}

	@Test
	void disconnectedMemberIsRemovedAfterTheGracePeriod() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper)) {
			WsTestClient alice = WsTestClient.join(port, roomId, "alice", "client-b", mapper);
			String aliceId = alice.memberId();

			alice.abort();
			nextMembers(bob, m -> disconnected(m, aliceId));

			JsonNode removed = nextMembers(bob, m -> m.get("members").size() == 1);
			assertThat(removed.get("members").get(0).get("name").asString()).isEqualTo("bob");
			try (WsTestClient late = WsTestClient.join(port, roomId, "alice", "client-b", mapper)) {
				assertThat(late.memberId()).isNotEqualTo(aliceId);
			}
		}
	}

	@Test
	void newConnectionReplacesAnOpenOneWithTheSameClientId() throws Exception {
		String roomId = api.newRoom(IP);
		try (WsTestClient first = WsTestClient.join(port, roomId, "alice", "client-c", mapper);
				WsTestClient second = WsTestClient.join(port, roomId, "alice", "client-c", mapper)) {
			assertThat(second.memberId()).isEqualTo(first.memberId());
			assertThat(first.awaitCloseCode()).isEqualTo(4410);

			// The replaced socket's close must not mark the member disconnected.
			TimeUnit.MILLISECONDS.sleep(200);
			try (WsTestClient bob = WsTestClient.join(port, roomId, "bob", mapper)) {
				JsonNode members = bob.welcome.get("room").get("members");
				assertThat(members).hasSize(2);
				assertThat(members.get(0).get("connected").asBoolean()).isTrue();
			}
		}
	}

	@Test
	void helloWithoutClientIdIsBadMessage() throws Exception {
		try (WsTestClient client = WsTestClient.connect(port, api.newRoom(IP), mapper)) {
			client.send("{\"type\":\"hello\",\"protocolVersion\":1,\"name\":\"x\"}");

			assertThat(client.next("error").get("code").asString()).isEqualTo("BAD_MESSAGE");
		}
	}

	@Test
	void roomWithOnlyDisconnectedMembersCountsAsIdle() throws Exception {
		String roomId = api.newRoom(IP);
		WsTestClient alice = WsTestClient.join(port, roomId, "alice", "client-d", mapper);
		alice.abort();
		TimeUnit.MILLISECONDS.sleep(400); // > idle timeout, < reconnect grace

		roomService.sweepIdleRooms();

		assertThat(api.get("/api/rooms/" + roomId).statusCode()).isEqualTo(404);
	}

	private static JsonNode nextMembers(WsTestClient client, Predicate<JsonNode> condition) {
		while (true) {
			JsonNode members = client.next("members");
			if (condition.test(members)) {
				return members;
			}
		}
	}

	private static boolean connected(JsonNode members, String memberId) {
		JsonNode member = find(members, memberId);
		return member != null && member.get("connected").asBoolean();
	}

	private static boolean disconnected(JsonNode members, String memberId) {
		JsonNode member = find(members, memberId);
		return member != null && !member.get("connected").asBoolean();
	}

	private static JsonNode find(JsonNode members, String memberId) {
		for (JsonNode member : members.get("members")) {
			if (member.get("memberId").asString().equals(memberId)) {
				return member;
			}
		}
		return null;
	}
}
