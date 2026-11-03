package pl.lodz.p.sina.listening.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;

import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.protocol.PlaybackState;
import pl.lodz.p.sina.listening.protocol.PlaybackStatus;
import pl.lodz.p.sina.listening.protocol.Track;

class PlaybackTransitionsTest {

	private static final double LEAD = 1000;
	private static final Track A = track("t_a", 200_000);
	private static final Track B = track("t_b", 100_000);
	private static final List<Track> QUEUE = List.of(A, B);

	private static Track track(String id, double durationMs) {
		return new Track(id, id, durationMs, 1, "audio/mpeg", "m_x", "/x");
	}

	private static PlaybackState playing(String trackId, double position, double effectiveAt) {
		return new PlaybackState(7, PlaybackStatus.PLAYING, trackId, position, effectiveAt);
	}

	private static PlaybackState apply(String action, PlaybackState current, double now) {
		return PlaybackTransitions.apply(action, null, null, current, QUEUE, now, LEAD);
	}

	// T3
	@Test
	void playFromStoppedStartsFirstTrackAfterLeadTime() {
		PlaybackState next = apply("play", PlaybackState.initial(), 5_000);

		assertThat(next).isEqualTo(new PlaybackState(1, PlaybackStatus.PLAYING, "t_a", 0, 6_000));
	}

	@Test
	void playWithEmptyQueueIsInvalid() {
		assertThatThrownBy(() -> PlaybackTransitions.apply("play", null, null, PlaybackState.initial(), List.of(),
				0, LEAD)).isInstanceOf(CommandException.class);
	}

	@Test
	void playResumesFromPausedPosition() {
		PlaybackState paused = new PlaybackState(3, PlaybackStatus.PAUSED, "t_a", 31_000, 931_000);

		PlaybackState next = apply("play", paused, 945_000);

		assertThat(next).isEqualTo(new PlaybackState(4, PlaybackStatus.PLAYING, "t_a", 31_000, 946_000));
	}

	// T4 — the worked example from protocol §8
	@Test
	void pausePositionIsExpectedPositionAtNewEffectiveAt() {
		PlaybackState next = apply("pause", playing("t_a", 0, 900_000), 930_000);

		assertThat(next).isEqualTo(new PlaybackState(8, PlaybackStatus.PAUSED, "t_a", 31_000, 931_000));
	}

	@Test
	void pauseWhenNotPlayingIsInvalid() {
		assertThatThrownBy(() -> apply("pause", PlaybackState.initial(), 0)).isInstanceOf(CommandException.class);
	}

	// T5
	@Test
	void seekKeepsStatus() {
		PlaybackState paused = new PlaybackState(2, PlaybackStatus.PAUSED, "t_a", 10_000, 0);

		PlaybackState next = PlaybackTransitions.apply("seek", 95_000.0, null, paused, QUEUE, 50_000, LEAD);

		assertThat(next).isEqualTo(new PlaybackState(3, PlaybackStatus.PAUSED, "t_a", 95_000, 51_000));
	}

	@Test
	void seekOutsideTrackIsInvalid() {
		PlaybackState current = playing("t_b", 0, 0);

		for (double position : new double[] { -1, 100_000, 150_000 }) {
			assertThatThrownBy(() -> PlaybackTransitions.apply("seek", position, null, current, QUEUE, 0, LEAD))
					.isInstanceOf(CommandException.class);
		}
	}

	// T6
	@Test
	void skipMovesToNextTrack() {
		PlaybackState next = apply("skip", playing("t_a", 0, 0), 10_000);

		assertThat(next).isEqualTo(new PlaybackState(8, PlaybackStatus.PLAYING, "t_b", 0, 11_000));
	}

	@Test
	void skipOnLastTrackStops() {
		PlaybackState next = apply("skip", playing("t_b", 0, 0), 10_000);

		assertThat(next).isEqualTo(new PlaybackState(8, PlaybackStatus.STOPPED, null, 0, 11_000));
	}

	@Test
	void selectStartsTrackFromBeginning() {
		PlaybackState next = PlaybackTransitions.apply("select", null, "t_b", playing("t_a", 0, 0), QUEUE,
				10_000, LEAD);

		assertThat(next).isEqualTo(new PlaybackState(8, PlaybackStatus.PLAYING, "t_b", 0, 11_000));
	}

	@Test
	void selectUnknownTrackIsTrackNotFound() {
		assertThatThrownBy(() -> PlaybackTransitions.apply("select", null, "t_zz", playing("t_a", 0, 0), QUEUE,
				0, LEAD))
				.isInstanceOfSatisfying(CommandException.class,
						e -> assertThat(e.code()).isEqualTo(ErrorCode.TRACK_NOT_FOUND));
	}

	// T7
	@Test
	void removingCurrentTrackSkips() {
		PlaybackState next = PlaybackTransitions.apply("remove", null, "t_a", playing("t_a", 0, 0), QUEUE,
				10_000, LEAD);

		assertThat(next).isEqualTo(new PlaybackState(8, PlaybackStatus.PLAYING, "t_b", 0, 11_000));
	}

	@Test
	void removingAnotherTrackLeavesStateUnchanged() {
		PlaybackState current = playing("t_a", 0, 0);

		PlaybackState next = PlaybackTransitions.apply("remove", null, "t_b", current, QUEUE, 10_000, LEAD);

		assertThat(next).isSameAs(current);
	}

	// T8
	@Test
	void everyChangeIncrementsRevByOne() {
		PlaybackState state = PlaybackState.initial();
		double now = 0;
		for (String action : List.of("play", "pause", "play", "skip")) {
			now += 5_000;
			PlaybackState next = apply(action, state, now);
			assertThat(next.rev()).isEqualTo(state.rev() + 1);
			state = next;
		}
	}

	@Test
	void effectiveAtNeverMovesBackwards() {
		// e.g. an auto-advance state that takes effect further in the future than now + lead
		PlaybackState current = playing("t_b", 0, 20_000);

		PlaybackState next = apply("pause", current, 10_000);

		assertThat(next.effectiveAt()).isEqualTo(20_000);
		assertThat(next.position()).isEqualTo(0);
	}

	@Test
	void unknownActionIsInvalid() {
		assertThatThrownBy(() -> apply("dance", PlaybackState.initial(), 0))
				.isInstanceOfSatisfying(CommandException.class,
						e -> assertThat(e.code()).isEqualTo(ErrorCode.INVALID_COMMAND));
	}

	// T9
	@Test
	void autoAdvanceStartsNextTrackExactlyAtEndWithoutGap() {
		// t_a (200 s) playing from 30 s at server time 100 s → ends at 100 + 170 = 270 s
		PlaybackState current = playing("t_a", 30_000, 100_000);

		assertThat(PlaybackTransitions.endAt(current, QUEUE)).isEqualTo(270_000);
		assertThat(PlaybackTransitions.autoAdvance(current, QUEUE))
				.isEqualTo(new PlaybackState(8, PlaybackStatus.PLAYING, "t_b", 0, 270_000));
	}

	@Test
	void autoAdvanceAfterLastTrackStops() {
		PlaybackState current = playing("t_b", 0, 100_000);

		assertThat(PlaybackTransitions.autoAdvance(current, QUEUE))
				.isEqualTo(new PlaybackState(8, PlaybackStatus.STOPPED, null, 0, 200_000));
	}

	@Test
	void positionAtIsClampedToDuration() {
		PlaybackState current = playing("t_b", 90_000, 0);

		assertThat(PlaybackTransitions.positionAt(current, QUEUE, 5_000)).isEqualTo(95_000);
		assertThat(PlaybackTransitions.positionAt(current, QUEUE, 50_000)).isEqualTo(100_000);
	}
}
