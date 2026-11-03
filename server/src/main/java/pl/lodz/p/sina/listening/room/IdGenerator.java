package pl.lodz.p.sina.listening.room;

import java.security.SecureRandom;

import org.springframework.stereotype.Component;

@Component
public class IdGenerator {

	// No look-alike characters (0/o, 1/l/i), so room links can be read out loud or typed from a screen.
	static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

	private final SecureRandom random = new SecureRandom();

	public String roomId() {
		return random(6);
	}

	public String memberId() {
		return "m_" + random(6);
	}

	public String trackId() {
		return "t_" + random(8);
	}

	private String random(int length) {
		StringBuilder sb = new StringBuilder(length);
		for (int i = 0; i < length; i++) {
			sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
		}
		return sb.toString();
	}
}
