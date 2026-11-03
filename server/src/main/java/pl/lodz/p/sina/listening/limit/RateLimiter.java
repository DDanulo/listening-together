package pl.lodz.p.sina.listening.limit;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import pl.lodz.p.sina.listening.clock.ServerClock;
import pl.lodz.p.sina.listening.config.AppProperties;

/** Per-client-IP limits for the HTTP endpoints that create things. */
@Component
public class RateLimiter {

	static final double WINDOW_MS = 10 * 60 * 1000;

	public enum Action {
		CREATE_ROOM, UPLOAD
	}

	private record Key(Action action, String clientIp) {
	}

	private final Map<Key, TokenBucket> buckets = new ConcurrentHashMap<>();
	private final ServerClock clock;
	private final AppProperties.RateLimits limits;

	public RateLimiter(ServerClock clock, AppProperties properties) {
		this.clock = clock;
		this.limits = properties.rateLimits();
	}

	public boolean tryAcquire(Action action, String clientIp) {
		double now = clock.nowMs();
		int count = action == Action.CREATE_ROOM ? limits.roomsPer10Min() : limits.uploadsPer10Min();
		return buckets.computeIfAbsent(new Key(action, clientIp), k -> TokenBucket.perWindow(count, WINDOW_MS, now))
				.tryTake(now);
	}

	/** Drops buckets that have refilled, so the map doesn't grow with every client ever seen. */
	public void prune() {
		double now = clock.nowMs();
		buckets.values().removeIf(bucket -> bucket.isFull(now));
	}
}
