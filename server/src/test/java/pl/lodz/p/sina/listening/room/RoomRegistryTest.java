package pl.lodz.p.sina.listening.room;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.Test;

class RoomRegistryTest {

	private final RoomRegistry registry = new RoomRegistry(new IdGenerator(), () -> 0);

	@Test
	void refusesRoomsBeyondTheCap() {
		assertThat(registry.tryCreate(2)).isPresent();
		assertThat(registry.tryCreate(2)).isPresent();
		assertThat(registry.tryCreate(2)).isEmpty();
	}

	@Test
	void concurrentCreatorsCannotOvershootTheCap() throws Exception {
		int threads = 32;
		ExecutorService pool = Executors.newFixedThreadPool(threads);
		CountDownLatch start = new CountDownLatch(1);
		List<Future<Boolean>> results = new ArrayList<>();
		for (int i = 0; i < threads * 4; i++) {
			results.add(pool.submit(() -> {
				start.await();
				return registry.tryCreate(10).isPresent();
			}));
		}
		start.countDown();

		long created = 0;
		for (Future<Boolean> result : results) {
			created += result.get() ? 1 : 0;
		}
		pool.shutdown();

		assertThat(created).isEqualTo(10);
		assertThat(registry.size()).isEqualTo(10);
	}
}
