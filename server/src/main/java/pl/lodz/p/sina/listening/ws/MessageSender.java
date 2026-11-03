package pl.lodz.p.sina.listening.ws;

import java.io.IOException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import pl.lodz.p.sina.listening.protocol.ServerMessage;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;

@Component
public class MessageSender {

	private static final Logger log = LoggerFactory.getLogger(MessageSender.class);

	private final ObjectWriter writer;

	public MessageSender(JsonMapper mapper) {
		// writerFor the base type, so the "type" property is always included.
		this.writer = mapper.writerFor(ServerMessage.class);
	}

	public TextMessage encode(ServerMessage message) {
		return new TextMessage(writer.writeValueAsString(message));
	}

	/**
	 * Never throws: a failure to reach one client must not abort a broadcast to the others, or the caller's state
	 * update (e.g. scheduling auto-advance).
	 *
	 * @param session must be a ConcurrentWebSocketSessionDecorator when other threads may send too
	 */
	public void send(WebSocketSession session, ServerMessage message) {
		send(session, encode(message));
	}

	public void send(WebSocketSession session, TextMessage message) {
		if (!session.isOpen()) {
			return;
		}
		try {
			session.sendMessage(message);
		}
		catch (IOException | RuntimeException e) {
			// Includes SessionLimitExceededException: the decorator closes a client that falls too far behind.
			log.debug("Send to {} failed: {}", session.getId(), e.getMessage());
		}
	}
}
