package pl.lodz.p.sina.listening.protocol;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum DownloadStatus {
	@JsonProperty("downloading") DOWNLOADING,
	@JsonProperty("ready") READY,
	@JsonProperty("error") ERROR
}
