package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.fail;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Minimal protocol client for integration tests, on the JDK's WebSocket client. */
final class WsTestClient implements WebSocket.Listener, AutoCloseable {

	private final JsonMapper mapper;
	private final BlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
	private final CompletableFuture<Integer> closeCode = new CompletableFuture<>();
	private final StringBuilder partial = new StringBuilder();
	private WebSocket ws;

	private WsTestClient(JsonMapper mapper) {
		this.mapper = mapper;
	}

	static WsTestClient connect(int port, String roomId, JsonMapper mapper) {
		WsTestClient client = new WsTestClient(mapper);
		client.ws = HttpClient.newHttpClient().newWebSocketBuilder()
				.buildAsync(URI.create("ws://localhost:" + port + "/ws/rooms/" + roomId), client)
				.join();
		return client;
	}

	/** Connects and joins; returns the client with the welcome message already consumed. */
	static WsTestClient join(int port, String roomId, String name, JsonMapper mapper) {
		WsTestClient client = connect(port, roomId, mapper);
		client.send("{\"type\":\"hello\",\"protocolVersion\":1,\"clientId\":\"c-" + name + "\",\"name\":\"" + name
				+ "\"}");
		client.welcome = client.next("welcome");
		return client;
	}

	JsonNode welcome;

	String memberId() {
		return welcome.get("memberId").asString();
	}

	void send(String json) {
		ws.sendText(json, true).join();
	}

	/** Next message of the given type, skipping others; fails after 5 s. */
	JsonNode next(String type) {
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
		try {
			while (System.nanoTime() < deadline) {
				JsonNode message = messages.poll(deadline - System.nanoTime(), TimeUnit.NANOSECONDS);
				if (message != null && type.equals(message.get("type").asString())) {
					return message;
				}
			}
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
		return fail("No '" + type + "' message within 5 s");
	}

	int awaitCloseCode() {
		return closeCode.orTimeout(5, TimeUnit.SECONDS).join();
	}

	@Override
	public void onOpen(WebSocket webSocket) {
		webSocket.request(1);
	}

	@Override
	public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
		partial.append(data);
		if (last) {
			messages.add(mapper.readTree(partial.toString()));
			partial.setLength(0);
		}
		webSocket.request(1);
		return null;
	}

	@Override
	public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
		closeCode.complete(statusCode);
		return null;
	}

	@Override
	public void onError(WebSocket webSocket, Throwable error) {
		closeCode.completeExceptionally(error);
	}

	@Override
	public void close() {
		if (!ws.isOutputClosed()) {
			ws.sendClose(WebSocket.NORMAL_CLOSURE, "").exceptionally(e -> null).join();
		}
	}
}
