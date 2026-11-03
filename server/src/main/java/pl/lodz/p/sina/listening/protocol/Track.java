package pl.lodz.p.sina.listening.protocol;

public record Track(
		String trackId,
		String title,
		double durationMs,
		long sizeBytes,
		String mimeType,
		String uploadedBy,
		String url) {
}
