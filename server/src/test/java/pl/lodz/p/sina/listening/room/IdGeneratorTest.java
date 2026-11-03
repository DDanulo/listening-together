package pl.lodz.p.sina.listening.room;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class IdGeneratorTest {

	private final IdGenerator ids = new IdGenerator();

	@Test
	void roomIdsAreSixCharactersWithoutLookAlikes() {
		for (int i = 0; i < 1000; i++) {
			assertThat(ids.roomId()).matches("[" + IdGenerator.ALPHABET + "]{6}");
		}
	}

	@Test
	void memberAndTrackIdsArePrefixed() {
		assertThat(ids.memberId()).matches("m_[" + IdGenerator.ALPHABET + "]{6}");
		assertThat(ids.trackId()).matches("t_[" + IdGenerator.ALPHABET + "]{8}");
	}
}
