package pl.lodz.p.sina.listening.log;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

import pl.lodz.p.sina.listening.clock.ServerClock;
import pl.lodz.p.sina.listening.config.AppProperties;
import tools.jackson.databind.json.JsonMapper;

/**
 * JSON-lines event log for the evaluation ({@code logs/events-<date>.jsonl}). Writes happen on a background
 * thread so WebSocket handlers never wait for disk I/O. The format is parsed by {@code eval/}: change both together.
 */
@Component
public class EventLog implements DisposableBean {

	private static final Logger log = LoggerFactory.getLogger(EventLog.class);

	private final ExecutorService writer = Executors.newSingleThreadExecutor(Thread.ofPlatform()
			.name("event-log").daemon().factory());
	private final Path dir;
	private final JsonMapper mapper;
	private final ServerClock clock;
	private BufferedWriter out;
	private LocalDate outDate;

	public EventLog(AppProperties properties, JsonMapper mapper, ServerClock clock) {
		this.dir = Path.of(properties.log().dir());
		this.mapper = mapper;
		this.clock = clock;
	}

	/** Builds an ordered field map; values may be null. */
	public static Map<String, Object> fields(Object... keysAndValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i + 1 < keysAndValues.length; i += 2) {
			map.put((String) keysAndValues[i], keysAndValues[i + 1]);
		}
		return map;
	}

	public void log(String event, String roomId, String memberId, Map<String, Object> fields) {
		Map<String, Object> line = new LinkedHashMap<>();
		// wallTime is for humans reading the log only; serverTime is the protocol clock.
		line.put("wallTime", Instant.now().toString());
		line.put("serverTime", clock.nowMs());
		line.put("roomId", roomId);
		line.put("memberId", memberId);
		line.put("event", event);
		line.putAll(fields);
		String json = mapper.writeValueAsString(line);
		writer.execute(() -> write(json));
	}

	private void write(String json) {
		try {
			LocalDate today = LocalDate.now();
			if (out == null || !today.equals(outDate)) {
				if (out != null) {
					out.close();
				}
				Files.createDirectories(dir);
				out = Files.newBufferedWriter(dir.resolve("events-" + today + ".jsonl"), StandardCharsets.UTF_8,
						StandardOpenOption.CREATE, StandardOpenOption.APPEND);
				outDate = today;
			}
			out.write(json);
			out.newLine();
			out.flush();
		}
		catch (IOException e) {
			log.warn("Could not write event log: {}", e.getMessage());
		}
	}

	@Override
	public void destroy() throws Exception {
		writer.shutdown();
		writer.awaitTermination(5, TimeUnit.SECONDS);
		if (out != null) {
			out.close();
		}
	}
}
