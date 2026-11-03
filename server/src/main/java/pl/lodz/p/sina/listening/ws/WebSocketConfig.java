package pl.lodz.p.sina.listening.ws;

import java.util.List;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistration;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import pl.lodz.p.sina.listening.config.AppProperties;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

	private final RoomSocketHandler handler;
	private final List<String> allowedOrigins;

	public WebSocketConfig(RoomSocketHandler handler, AppProperties properties) {
		this.handler = handler;
		this.allowedOrigins = properties.ws().allowedOrigins();
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		// Raw WebSocket (no STOMP): the protocol is plain JSON frames.
		WebSocketHandlerRegistration registration = registry.addHandler(handler, "/ws/rooms/*");
		// Default is same-origin only, which works behind the Vite proxy and Caddy.
		if (!allowedOrigins.isEmpty()) {
			registration.setAllowedOriginPatterns(allowedOrigins.toArray(String[]::new));
		}
	}
}
