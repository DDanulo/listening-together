package pl.lodz.p.sina.listening.room;

import java.util.List;
import java.util.Optional;

import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.protocol.PlaybackState;
import pl.lodz.p.sina.listening.protocol.PlaybackStatus;
import pl.lodz.p.sina.listening.protocol.Track;

/**
 * Pure playback state machine (protocol §5–6). No clock, no I/O: callers pass the current server time in.
 */
public final class PlaybackTransitions {

	private PlaybackTransitions() {
	}

	/**
	 * Computes the state after a client command. For {@code remove}, returns {@code current} unchanged when the
	 * removed track isn't the current one; the caller removes the track from the queue.
	 *
	 * @throws CommandException if the command isn't valid in the current state
	 */
	public static PlaybackState apply(String action, Double position, String trackId,
			PlaybackState current, List<Track> queue, double now, double leadMs) {
		// The new effectiveAt is never earlier than the current one, so positions can be computed from the
		// current state alone (protocol §6.1).
		double at = Math.max(now + leadMs, current.effectiveAt());
		if (action == null) {
			throw invalid("Missing action");
		}
		return switch (action) {
			case "play" -> play(current, queue, at);
			case "pause" -> pause(current, queue, at);
			case "seek" -> seek(current, queue, position, at);
			case "skip" -> skip(current, queue, at);
			case "select" -> select(current, queue, trackId, at);
			case "remove" -> remove(current, queue, trackId, at);
			default -> throw invalid("Unknown action: " + action);
		};
	}

	/** Server time at which the current track ends; only meaningful while playing. */
	public static double endAt(PlaybackState state, List<Track> queue) {
		double duration = find(queue, state.trackId()).map(Track::durationMs).orElse(state.position());
		return state.effectiveAt() + (duration - state.position());
	}

	/** State that takes effect when the current track ends: next track without a gap, or stopped. */
	public static PlaybackState autoAdvance(PlaybackState current, List<Track> queue) {
		return next(current, queue, endAt(current, queue));
	}

	/** Track position at server time {@code at}, clamped to the track's duration. */
	public static double positionAt(PlaybackState state, List<Track> queue, double at) {
		if (state.status() != PlaybackStatus.PLAYING) {
			return state.position();
		}
		double duration = find(queue, state.trackId()).map(Track::durationMs).orElse(Double.MAX_VALUE);
		double position = state.position() + (at - state.effectiveAt());
		return Math.clamp(position, 0, duration);
	}

	private static PlaybackState play(PlaybackState current, List<Track> queue, double at) {
		return switch (current.status()) {
			case PLAYING -> throw invalid("Already playing");
			case PAUSED -> state(current, PlaybackStatus.PLAYING, current.trackId(), current.position(), at);
			case STOPPED -> {
				if (queue.isEmpty()) {
					throw invalid("The queue is empty");
				}
				yield state(current, PlaybackStatus.PLAYING, queue.getFirst().trackId(), 0, at);
			}
		};
	}

	private static PlaybackState pause(PlaybackState current, List<Track> queue, double at) {
		if (current.status() != PlaybackStatus.PLAYING) {
			throw invalid("Not playing");
		}
		return state(current, PlaybackStatus.PAUSED, current.trackId(), positionAt(current, queue, at), at);
	}

	private static PlaybackState seek(PlaybackState current, List<Track> queue, Double position, double at) {
		if (current.status() == PlaybackStatus.STOPPED) {
			throw invalid("Nothing to seek in");
		}
		double duration = find(queue, current.trackId()).map(Track::durationMs).orElse(0.0);
		if (position == null || position < 0 || position >= duration) {
			throw invalid("Position must be within [0, " + duration + ")");
		}
		return state(current, current.status(), current.trackId(), position, at);
	}

	private static PlaybackState skip(PlaybackState current, List<Track> queue, double at) {
		if (current.status() == PlaybackStatus.STOPPED) {
			throw invalid("Nothing to skip");
		}
		return next(current, queue, at);
	}

	private static PlaybackState select(PlaybackState current, List<Track> queue, String trackId, double at) {
		Track track = find(queue, trackId)
				.orElseThrow(() -> new CommandException(ErrorCode.TRACK_NOT_FOUND, "No track with id " + trackId));
		return state(current, PlaybackStatus.PLAYING, track.trackId(), 0, at);
	}

	private static PlaybackState remove(PlaybackState current, List<Track> queue, String trackId, double at) {
		if (find(queue, trackId).isEmpty()) {
			throw new CommandException(ErrorCode.TRACK_NOT_FOUND, "No track with id " + trackId);
		}
		boolean isCurrent = current.status() != PlaybackStatus.STOPPED && trackId.equals(current.trackId());
		return isCurrent ? next(current, queue, at) : current;
	}

	/** Next track in the queue from position 0, or stopped if the current one is the last. */
	private static PlaybackState next(PlaybackState current, List<Track> queue, double at) {
		int index = indexOf(queue, current.trackId());
		if (index >= 0 && index + 1 < queue.size()) {
			return state(current, PlaybackStatus.PLAYING, queue.get(index + 1).trackId(), 0, at);
		}
		return state(current, PlaybackStatus.STOPPED, null, 0, at);
	}

	private static PlaybackState state(PlaybackState current, PlaybackStatus status, String trackId,
			double position, double at) {
		return new PlaybackState(current.rev() + 1, status, trackId, position, at);
	}

	private static Optional<Track> find(List<Track> queue, String trackId) {
		return queue.stream().filter(t -> t.trackId().equals(trackId)).findFirst();
	}

	private static int indexOf(List<Track> queue, String trackId) {
		for (int i = 0; i < queue.size(); i++) {
			if (queue.get(i).trackId().equals(trackId)) {
				return i;
			}
		}
		return -1;
	}

	private static CommandException invalid(String message) {
		return new CommandException(ErrorCode.INVALID_COMMAND, message);
	}
}
