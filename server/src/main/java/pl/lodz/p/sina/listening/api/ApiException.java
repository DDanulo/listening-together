package pl.lodz.p.sina.listening.api;

import org.springframework.http.HttpStatus;

import pl.lodz.p.sina.listening.protocol.ErrorCode;

public class ApiException extends RuntimeException {

	private final HttpStatus status;
	private final ErrorCode code;

	public ApiException(HttpStatus status, ErrorCode code, String message) {
		super(message);
		this.status = status;
		this.code = code;
	}

	public HttpStatus status() {
		return status;
	}

	public ErrorCode code() {
		return code;
	}

	static ApiException roomNotFound() {
		return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.ROOM_NOT_FOUND, "Room not found");
	}

	static ApiException rateLimited() {
		return new ApiException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED,
				"Too many requests, try again in a few minutes");
	}
}
