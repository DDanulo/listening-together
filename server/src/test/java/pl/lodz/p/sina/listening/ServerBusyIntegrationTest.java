package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import pl.lodz.p.sina.listening.room.RoomService;
import tools.jackson.databind.json.JsonMapper;

/** The server-wide room cap, in its own context so other tests' rooms don't count toward it. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"app.log.dir=target/test-logs",
		"app.rooms.max-rooms=2",
		"app.rooms.idle-timeout-ms=100",
		"app.rate-limits.roomsPer10Min=3",
})
class ServerBusyIntegrationTest {

	private static final String IP = "192.0.2.10";

	@LocalServerPort
	int port;

	@Autowired
	JsonMapper mapper;

	@Autowired
	RoomService roomService;

	@Test
	void fullServerRefusesWith503WithoutUsingUpTheRateLimit() throws Exception {
		TestApi api = new TestApi(port, mapper);
		assertThat(api.createRoom(IP).statusCode()).isEqualTo(201);
		assertThat(api.createRoom(IP).statusCode()).isEqualTo(201);

		for (int i = 0; i < 3; i++) {
			HttpResponse<String> busy = api.createRoom(IP);
			assertThat(busy.statusCode()).isEqualTo(503);
			assertThat(api.json(busy).get("code").asString()).isEqualTo("SERVER_BUSY");
		}

		// once the idle rooms are gone, the client still has its third room: the refusals didn't cost tokens
		Thread.sleep(200);
		roomService.sweepIdleRooms();
		assertThat(api.createRoom(IP).statusCode()).isEqualTo(201);
	}
}
