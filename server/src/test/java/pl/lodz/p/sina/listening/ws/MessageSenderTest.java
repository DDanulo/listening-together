package pl.lodz.p.sina.listening.ws;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.io.IOException;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.SessionLimitExceededException;

import pl.lodz.p.sina.listening.protocol.ServerMessage;
import tools.jackson.databind.json.JsonMapper;

class MessageSenderTest {

	private final MessageSender sender = new MessageSender(JsonMapper.builder().build());

	private static WebSocketSession failingWith(Exception failure) throws IOException {
		WebSocketSession session = mock(WebSocketSession.class);
		when(session.isOpen()).thenReturn(true);
		doThrow(failure).when(session).sendMessage(any(WebSocketMessage.class));
		return session;
	}

	@Test
	void slowClientOverflowDoesNotEscape() throws IOException {
		// what ConcurrentWebSocketSessionDecorator throws when a client falls too far behind
		WebSocketSession session = failingWith(
				new SessionLimitExceededException("Buffer size exceeded", CloseStatus.SESSION_NOT_RELIABLE));

		assertThatCode(() -> sender.send(session, new ServerMessage.Pong(1, 2, 3, 4))).doesNotThrowAnyException();
	}

	@Test
	void ioFailureDoesNotEscape() throws IOException {
		WebSocketSession session = failingWith(new IOException("Broken pipe"));

		assertThatCode(() -> sender.send(session, new ServerMessage.Pong(1, 2, 3, 4))).doesNotThrowAnyException();
	}
}
