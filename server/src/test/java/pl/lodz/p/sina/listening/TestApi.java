package pl.lodz.p.sina.listening;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** HTTP helpers for integration tests. {@code clientIp} is sent as X-Forwarded-For, like Caddy does. */
final class TestApi {

	private final HttpClient http = HttpClient.newHttpClient();
	private final int port;
	private final JsonMapper mapper;

	TestApi(int port, JsonMapper mapper) {
		this.port = port;
		this.mapper = mapper;
	}

	/** Bytes that start like an MP3 file (ID3 tag), padded to {@code size}. */
	static byte[] mp3(int size) {
		byte[] content = new byte[size];
		byte[] magic = "ID3".getBytes(StandardCharsets.US_ASCII);
		System.arraycopy(magic, 0, content, 0, Math.min(magic.length, size));
		return content;
	}

	static byte[] startingWith(String ascii, int size) {
		byte[] magic = ascii.getBytes(StandardCharsets.ISO_8859_1);
		byte[] content = Arrays.copyOf(magic, Math.max(size, magic.length));
		return content;
	}

	HttpResponse<String> createRoom(String clientIp) throws Exception {
		return http.send(request("/api/rooms", clientIp).POST(HttpRequest.BodyPublishers.noBody()).build(),
				HttpResponse.BodyHandlers.ofString());
	}

	String newRoom(String clientIp) throws Exception {
		HttpResponse<String> response = createRoom(clientIp);
		assertThat(response.statusCode()).isEqualTo(201);
		return json(response).get("roomId").asString();
	}

	HttpResponse<String> get(String path) throws Exception {
		return http.send(request(path, "127.0.0.1").GET().build(), HttpResponse.BodyHandlers.ofString());
	}

	HttpResponse<byte[]> download(String path) throws Exception {
		return http.send(request(path, "127.0.0.1").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
	}

	HttpResponse<String> upload(String roomId, String memberId, String fileName, String contentType, byte[] content,
			String clientIp) throws Exception {
		String boundary = UUID.randomUUID().toString();
		ByteArrayOutputStream body = new ByteArrayOutputStream();
		for (Map.Entry<String, String> field : Map.of("durationMs", "123000", "memberId", memberId).entrySet()) {
			body.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field.getKey()
					+ "\"\r\n\r\n" + field.getValue() + "\r\n").getBytes(StandardCharsets.UTF_8));
		}
		body.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
				+ fileName + "\"\r\nContent-Type: " + contentType + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
		body.writeBytes(content);
		body.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

		return http.send(request("/api/rooms/" + roomId + "/tracks", clientIp)
				.header("Content-Type", "multipart/form-data; boundary=" + boundary)
				.POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()))
				.build(), HttpResponse.BodyHandlers.ofString());
	}

	JsonNode json(HttpResponse<String> response) {
		return mapper.readTree(response.body());
	}

	private HttpRequest.Builder request(String path, String clientIp) {
		return HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
				.header("X-Forwarded-For", clientIp);
	}
}
