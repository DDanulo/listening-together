package pl.lodz.p.sina.listening.storage;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

/**
 * Audio formats accepted for upload, detected from the file's first bytes. The file name and the browser's
 * Content-Type are client input and never decide what gets stored and served.
 */
public enum AudioFormat {
	MP3("audio/mpeg", ".mp3"),
	FLAC("audio/flac", ".flac"),
	OGG("audio/ogg", ".ogg"),
	WAV("audio/wav", ".wav"),
	MP4("audio/mp4", ".m4a"),
	WEBM("audio/webm", ".webm");

	/** Bytes needed by {@link #detect}. */
	public static final int HEADER_LENGTH = 12;

	private final String mimeType;
	private final String extension;

	AudioFormat(String mimeType, String extension) {
		this.mimeType = mimeType;
		this.extension = extension;
	}

	public String mimeType() {
		return mimeType;
	}

	public String extension() {
		return extension;
	}

	public static Optional<AudioFormat> detect(byte[] header) {
		if (startsWith(header, 0, "ID3") || isMpegFrameSync(header)) {
			return Optional.of(MP3);
		}
		if (startsWith(header, 0, "fLaC")) {
			return Optional.of(FLAC);
		}
		if (startsWith(header, 0, "OggS")) {
			return Optional.of(OGG);
		}
		if (startsWith(header, 0, "RIFF") && startsWith(header, 8, "WAVE")) {
			return Optional.of(WAV);
		}
		if (startsWith(header, 4, "ftyp")) {
			return Optional.of(MP4);
		}
		if (header.length >= 4 && (header[0] & 0xFF) == 0x1A && (header[1] & 0xFF) == 0x45
				&& (header[2] & 0xFF) == 0xDF && (header[3] & 0xFF) == 0xA3) {
			return Optional.of(WEBM);
		}
		return Optional.empty();
	}

	/** MP3 without an ID3 tag starts directly with an 11-bit frame sync (also matches ADTS AAC). */
	private static boolean isMpegFrameSync(byte[] header) {
		return header.length >= 2 && (header[0] & 0xFF) == 0xFF && (header[1] & 0xE0) == 0xE0;
	}

	private static boolean startsWith(byte[] header, int offset, String magic) {
		byte[] expected = magic.getBytes(StandardCharsets.US_ASCII);
		return header.length >= offset + expected.length
				&& Arrays.equals(header, offset, offset + expected.length, expected, 0, expected.length);
	}
}
