package pl.lodz.p.sina.listening.storage;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import pl.lodz.p.sina.listening.config.AppProperties;

/** Stores uploaded files on disk, one directory per room, within a total size quota. */
@Component
public class TrackStorage {

	private static final Logger log = LoggerFactory.getLogger(TrackStorage.class);

	private final Path baseDir;
	private final long maxBytes;
	private final AtomicLong usedBytes = new AtomicLong();

	public TrackStorage(AppProperties properties) throws IOException {
		String dir = properties.storage().dir();
		this.baseDir = dir.isBlank() ? Files.createTempDirectory("listening-together-") : Path.of(dir);
		this.maxBytes = properties.storage().maxSize().toBytes();
	}

	/** Reserves quota for a file before writing it. Returns false if the quota would be exceeded. */
	public boolean reserve(long bytes) {
		while (true) {
			long used = usedBytes.get();
			if (used + bytes > maxBytes) {
				return false;
			}
			if (usedBytes.compareAndSet(used, used + bytes)) {
				return true;
			}
		}
	}

	public void release(long bytes) {
		usedBytes.addAndGet(-bytes);
	}

	public long usedBytes() {
		return usedBytes.get();
	}

	/** Writes a file whose quota was already reserved. */
	public Path store(String roomId, String trackId, AudioFormat format, MultipartFile file) {
		try {
			Path roomDir = Files.createDirectories(baseDir.resolve(roomId));
			Path target = roomDir.resolve(trackId + format.extension());
			file.transferTo(target);
			return target;
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	/** Deletes one stored file and gives its quota back. */
	public void delete(Path file, long bytes) {
		try {
			Files.deleteIfExists(file);
		}
		catch (IOException e) {
			log.warn("Could not delete {}: {}", file, e.getMessage());
		}
		release(bytes);
	}

	/** Deletes a room's directory with whatever is left in it. Quota is released by the caller per track. */
	public void deleteRoomDir(String roomId) {
		Path roomDir = baseDir.resolve(roomId);
		if (!Files.exists(roomDir)) {
			return;
		}
		try (Stream<Path> paths = Files.walk(roomDir)) {
			paths.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
		}
		catch (IOException e) {
			log.warn("Could not delete {}: {}", roomDir, e.getMessage());
		}
	}
}
