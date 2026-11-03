package pl.lodz.p.sina.listening.limit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class TokenBucketTest {

	@Test
	void allowsBurstThenRefillsOverTime() {
		TokenBucket bucket = TokenBucket.perWindow(3, 3_000, 0); // 3 per 3 s → 1 token per second

		assertThat(bucket.tryTake(0)).isTrue();
		assertThat(bucket.tryTake(0)).isTrue();
		assertThat(bucket.tryTake(0)).isTrue();
		assertThat(bucket.tryTake(0)).isFalse();

		assertThat(bucket.tryTake(999)).isFalse();
		assertThat(bucket.tryTake(1_000)).isTrue();
	}

	@Test
	void neverExceedsCapacity() {
		TokenBucket bucket = TokenBucket.perWindow(2, 1_000, 0);

		// a long idle period refills only up to the capacity
		assertThat(bucket.tryTake(1_000_000)).isTrue();
		assertThat(bucket.tryTake(1_000_000)).isTrue();
		assertThat(bucket.tryTake(1_000_000)).isFalse();
	}

	@Test
	void isFullOnceRefilled() {
		TokenBucket bucket = TokenBucket.perWindow(2, 1_000, 0);
		bucket.tryTake(0);

		assertThat(bucket.isFull(100)).isFalse();
		assertThat(bucket.isFull(500)).isTrue();
	}
}
