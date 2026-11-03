package pl.lodz.p.sina.listening.config;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class SchedulingConfig {

	/**
	 * Timers for auto-advance, throttled broadcasts, room cleanup and hello timeouts. A pool, so one broadcast
	 * stuck on a slow client's socket can't delay another room's auto-advance past its lead time.
	 * No file I/O here: use {@link #fileIo()}.
	 */
	@Bean(destroyMethod = "shutdownNow")
	ScheduledExecutorService roomTimers() {
		return Executors.newScheduledThreadPool(4, Thread.ofPlatform().name("room-timers-", 0).daemon().factory());
	}

	/** Deleting files, off the WebSocket and timer threads (deletes can be slow and must not delay pongs). */
	@Bean(destroyMethod = "shutdown")
	ExecutorService fileIo() {
		return Executors.newSingleThreadExecutor(Thread.ofPlatform().name("file-io").daemon().factory());
	}
}
