package pl.lodz.p.sina.listening.clock;

/**
 * The server's reference clock for the protocol. Every protocol time (t1, t2, effectiveAt, …) comes from here.
 */
public interface ServerClock {

	/** Milliseconds on a monotonic clock with an arbitrary origin. Never wall-clock time. */
	double nowMs();
}
