package pl.lodz.p.sina.listening.limit;

/**
 * Token bucket: allows bursts of {@code capacity}, refilled continuously at {@code refillPerMs}. Thread-safe.
 * Times are passed in (ms on any monotonic clock), so it can be tested without waiting.
 */
public final class TokenBucket {

	private final double capacity;
	private final double refillPerMs;
	private double tokens;
	private double lastRefill;

	public TokenBucket(double capacity, double refillPerMs, double now) {
		this.capacity = capacity;
		this.refillPerMs = refillPerMs;
		this.tokens = capacity;
		this.lastRefill = now;
	}

	/** Allows bursts of {@code count}, refilled completely over {@code windowMs}. */
	public static TokenBucket perWindow(int count, double windowMs, double now) {
		return new TokenBucket(count, count / windowMs, now);
	}

	public synchronized boolean tryTake(double now) {
		refill(now);
		if (tokens < 1) {
			return false;
		}
		tokens -= 1;
		return true;
	}

	/** True once the bucket has refilled completely, i.e. it no longer restricts anyone and can be dropped. */
	public synchronized boolean isFull(double now) {
		refill(now);
		return tokens >= capacity;
	}

	private void refill(double now) {
		tokens = Math.min(capacity, tokens + Math.max(0, now - lastRefill) * refillPerMs);
		lastRefill = now;
	}
}
