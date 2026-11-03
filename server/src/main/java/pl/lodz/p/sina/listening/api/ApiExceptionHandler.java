package pl.lodz.p.sina.listening.api;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;

import pl.lodz.p.sina.listening.protocol.ErrorCode;

/** Error bodies as defined in protocol §2: {@code {code, message}}. */
@RestControllerAdvice
public class ApiExceptionHandler {

	public record ApiError(ErrorCode code, String message) {
	}

	@ExceptionHandler(ApiException.class)
	ResponseEntity<ApiError> api(ApiException e) {
		return ResponseEntity.status(e.status()).body(new ApiError(e.code(), e.getMessage()));
	}

	@ExceptionHandler(MaxUploadSizeExceededException.class)
	ResponseEntity<ApiError> tooLarge(MaxUploadSizeExceededException e) {
		return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE)
				.body(new ApiError(ErrorCode.FILE_TOO_LARGE, "File is too large"));
	}

	@ExceptionHandler({ MissingServletRequestPartException.class, MissingServletRequestParameterException.class,
			MethodArgumentTypeMismatchException.class, MultipartException.class })
	ResponseEntity<ApiError> badRequest(Exception e) {
		return ResponseEntity.badRequest().body(new ApiError(ErrorCode.BAD_REQUEST, e.getMessage()));
	}
}
