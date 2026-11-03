package pl.lodz.p.sina.listening.room;

import pl.lodz.p.sina.listening.protocol.ErrorCode;

/** A client request that is invalid in the current state; reported to the client as an {@code error} message. */
public class CommandException extends RuntimeException {

	private final ErrorCode code;

	public CommandException(ErrorCode code, String message) {
		super(message);
		this.code = code;
	}

	public ErrorCode code() {
		return code;
	}
}
