package pl.lodz.p.sina.listening.protocol;

import java.util.Map;

public record Member(
		String memberId,
		String name,
		boolean connected,
		Map<String, DownloadStatus> downloads,
		MemberSync sync) {
}
