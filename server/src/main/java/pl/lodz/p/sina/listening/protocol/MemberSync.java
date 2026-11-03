package pl.lodz.p.sina.listening.protocol;

public record MemberSync(double offsetMs, double rttMs, Double driftMs) {
}
