import { describe, expect, it } from "vitest";
import {
	clipAudioExportFields,
	clipAudioGainDb,
	clipAudioScalar,
	sameClipAudio,
} from "./clipAudio";

describe("clipAudio", () => {
	it("treats absent fields as 0 dB and unmuted", () => {
		expect(clipAudioGainDb({})).toBe(0);
		expect(clipAudioScalar({})).toBe(1);
		expect(clipAudioExportFields({})).toEqual({ hasAudio: true, gainDb: 0 });
	});

	it("uses the same dB law as the export and clamps to the inspector range", () => {
		expect(clipAudioScalar({ audioGainDb: -6.0206 })).toBeCloseTo(0.5, 4);
		expect(clipAudioGainDb({ audioGainDb: 99 })).toBe(12);
		expect(clipAudioGainDb({ audioGainDb: -99 })).toBe(-60);
	});

	it("silences a muted clip in preview and export", () => {
		expect(clipAudioScalar({ audioGainDb: 6, audioMuted: true })).toBe(0);
		expect(clipAudioExportFields({ audioGainDb: 6, audioMuted: true }).hasAudio).toBe(false);
	});

	it("compares audio so differently-levelled neighbours never merge", () => {
		expect(sameClipAudio({}, { audioGainDb: 0, audioMuted: false })).toBe(true);
		expect(sameClipAudio({}, { audioMuted: true })).toBe(false);
		expect(sameClipAudio({ audioGainDb: -3 }, {})).toBe(false);
	});
});
