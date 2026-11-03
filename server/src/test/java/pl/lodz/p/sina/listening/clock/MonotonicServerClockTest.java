package pl.lodz.p.sina.listening.clock;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class MonotonicServerClockTest {

	@Test
	void isMonotonicAndInMilliseconds() throws InterruptedException {
		MonotonicServerClock clock = new MonotonicServerClock();
		double first = clock.nowMs();
		Thread.sleep(50);
		double second = clock.nowMs();

		assertThat(second).isGreaterThan(first);
		// ms, not ns or s: 50 ms of sleep shows up as roughly 50, with generous scheduling slack
		assertThat(second - first).isBetween(45.0, 500.0);
	}
}
