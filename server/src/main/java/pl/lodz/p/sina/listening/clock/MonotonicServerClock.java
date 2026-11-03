package pl.lodz.p.sina.listening.clock;

import org.springframework.stereotype.Component;

@Component
public class MonotonicServerClock implements ServerClock {

	// nanoTime is immune to wall-clock adjustments (NTP steps, manual changes), which would break sync.
	private final long startNanos = System.nanoTime();

	@Override
	public double nowMs() {
		return (System.nanoTime() - startNanos) / 1_000_000.0;
	}
}
