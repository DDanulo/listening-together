package pl.lodz.p.sina.listening.storage;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;

class AudioFormatTest {

	private static byte[] bytes(String ascii) {
		return ascii.getBytes(StandardCharsets.ISO_8859_1);
	}

	@Test
	void detectsSupportedFormatsFromContent() {
		assertThat(AudioFormat.detect(bytes("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000")))
				.contains(AudioFormat.MP3);
		assertThat(AudioFormat.detect(new byte[] { (byte) 0xFF, (byte) 0xFB, (byte) 0x90, 0x00 }))
				.contains(AudioFormat.MP3);
		assertThat(AudioFormat.detect(bytes("fLaC\u0000\u0000\u0000\""))).contains(AudioFormat.FLAC);
		assertThat(AudioFormat.detect(bytes("OggS\u0000\u0002\u0000\u0000"))).contains(AudioFormat.OGG);
		assertThat(AudioFormat.detect(bytes("RIFF$\u0000\u0000\u0000WAVE"))).contains(AudioFormat.WAV);
		assertThat(AudioFormat.detect(bytes("\u0000\u0000\u0000 ftypM4A "))).contains(AudioFormat.MP4);
		assertThat(AudioFormat.detect(new byte[] { 0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0x00 }))
				.contains(AudioFormat.WEBM);
	}

	@Test
	void rejectsEverythingElse() {
		assertThat(AudioFormat.detect(bytes("PK\u0003\u0004 zip archive"))).isEmpty();
		assertThat(AudioFormat.detect(bytes("%PDF-1.7"))).isEmpty();
		assertThat(AudioFormat.detect(bytes("<html><script>"))).isEmpty();
		assertThat(AudioFormat.detect(bytes("MZ executable"))).isEmpty();
		assertThat(AudioFormat.detect(bytes("RIFF$\u0000\u0000\u0000AVI "))).isEmpty(); // RIFF, but video
		assertThat(AudioFormat.detect(new byte[0])).isEmpty();
	}
}
