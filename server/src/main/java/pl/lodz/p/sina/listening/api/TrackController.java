package pl.lodz.p.sina.listening.api;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.time.Duration;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import pl.lodz.p.sina.listening.config.AppProperties;
import pl.lodz.p.sina.listening.limit.RateLimiter;
import pl.lodz.p.sina.listening.protocol.ErrorCode;
import pl.lodz.p.sina.listening.protocol.Track;
import pl.lodz.p.sina.listening.room.CommandException;
import pl.lodz.p.sina.listening.room.IdGenerator;
import pl.lodz.p.sina.listening.room.Room;
import pl.lodz.p.sina.listening.room.RoomRegistry;
import pl.lodz.p.sina.listening.room.RoomService;
import pl.lodz.p.sina.listening.room.StoredTrack;
import pl.lodz.p.sina.listening.storage.AudioFormat;
import pl.lodz.p.sina.listening.storage.TrackStorage;

@RestController
@RequestMapping("/api/rooms/{roomId}/tracks")
public class TrackController {

	private final RoomRegistry rooms;
	private final RoomService roomService;
	private final TrackStorage storage;
	private final IdGenerator ids;
	private final RateLimiter rateLimiter;
	private final int maxTracks;
	private final int maxTitleLength;

	public TrackController(RoomRegistry rooms, RoomService roomService, TrackStorage storage, IdGenerator ids,
			RateLimiter rateLimiter, AppProperties properties) {
		this.rooms = rooms;
		this.roomService = roomService;
		this.storage = storage;
		this.ids = ids;
		this.rateLimiter = rateLimiter;
		this.maxTracks = properties.rooms().maxTracks();
		this.maxTitleLength = properties.rooms().maxTitleLength();
	}

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	Track upload(@PathVariable String roomId, @RequestPart("file") MultipartFile file,
			@RequestParam double durationMs, @RequestParam String memberId,
			@RequestParam(required = false) String title, HttpServletRequest request) {
		if (!rateLimiter.tryAcquire(RateLimiter.Action.UPLOAD, request.getRemoteAddr())) {
			throw ApiException.rateLimited();
		}
		Room room = rooms.find(roomId).orElseThrow(ApiException::roomNotFound);
		if (!room.hasMember(memberId)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST, "Unknown member " + memberId);
		}
		if (!(durationMs > 0)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.BAD_REQUEST, "durationMs must be positive");
		}
		// Cheap early check; addTrack checks again under the room lock.
		if (room.trackCount() >= maxTracks) {
			throw queueFull();
		}
		AudioFormat format = AudioFormat.detect(header(file)).orElseThrow(() -> new ApiException(
				HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCode.UNSUPPORTED_MEDIA_TYPE,
				"Not a supported audio file (MP3, FLAC, Ogg, WAV, M4A, WebM)"));
		if (!storage.reserve(file.getSize())) {
			throw new ApiException(HttpStatus.INSUFFICIENT_STORAGE, ErrorCode.STORAGE_FULL,
					"The server is out of storage, try again later");
		}

		String trackId = ids.trackId();
		String fileName = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
		Path path;
		try {
			// File I/O happens outside the room lock; only the queue update is locked.
			path = storage.store(roomId, trackId, format, file);
		}
		catch (RuntimeException e) {
			storage.release(file.getSize());
			throw e;
		}
		StoredTrack stored = new StoredTrack(new Track(
				trackId,
				titleOf(title, fileName),
				durationMs,
				file.getSize(),
				format.mimeType(),
				memberId,
				"/api/rooms/" + roomId + "/tracks/" + trackId + "/file"),
				path);
		try {
			roomService.addTrack(room, stored);
		}
		catch (CommandException e) {
			storage.delete(path, file.getSize());
			throw e.code() == ErrorCode.QUEUE_FULL ? queueFull() : ApiException.roomNotFound();
		}
		return stored.track();
	}

	@GetMapping("/{trackId}/file")
	ResponseEntity<Resource> download(@PathVariable String roomId, @PathVariable String trackId) {
		Room room = rooms.find(roomId).orElseThrow(ApiException::roomNotFound);
		StoredTrack stored = room.findTrack(trackId).orElseThrow(() ->
				new ApiException(HttpStatus.NOT_FOUND, ErrorCode.TRACK_NOT_FOUND, "No track with id " + trackId));
		return ResponseEntity.ok()
				.contentType(MediaType.parseMediaType(stored.track().mimeType()))
				.contentLength(stored.track().sizeBytes())
				// A track's file never changes.
				.cacheControl(CacheControl.maxAge(Duration.ofDays(1)).cachePrivate().immutable())
				// Uploads are untrusted: never let a browser sniff or render them as a page.
				.header("X-Content-Type-Options", "nosniff")
				.header("Content-Disposition", ContentDisposition.attachment().build().toString())
				.body(new FileSystemResource(stored.file()));
	}

	private static byte[] header(MultipartFile file) {
		try (InputStream in = file.getInputStream()) {
			return in.readNBytes(AudioFormat.HEADER_LENGTH);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private ApiException queueFull() {
		return new ApiException(HttpStatus.CONFLICT, ErrorCode.QUEUE_FULL,
				"The queue is full (" + maxTracks + " tracks)");
	}

	private String titleOf(String title, String fileName) {
		int dot = fileName.lastIndexOf('.');
		String result = title != null && !title.isBlank()
				? title.trim()
				: (dot > 0 ? fileName.substring(0, dot) : fileName).trim();
		if (result.isEmpty()) {
			result = "Untitled";
		}
		return result.length() > maxTitleLength ? result.substring(0, maxTitleLength) : result;
	}
}
