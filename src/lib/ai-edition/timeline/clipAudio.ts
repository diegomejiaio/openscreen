// The clip's own recorded audio level, set from the Edit clip dialog. One helper so the
// preview, the native export and the CLI export all read the same two fields the same way.

import type { AxcutClip } from "../schema";
import { audioGainScalar } from "../store/editorSettings";

export const CLIP_AUDIO_GAIN_MIN_DB = -60;
export const CLIP_AUDIO_GAIN_MAX_DB = 12;

type ClipAudioFields = Pick<AxcutClip, "audioGainDb" | "audioMuted">;

export function clipAudioGainDb(clip: ClipAudioFields): number {
	const gainDb = clip.audioGainDb ?? 0;
	return Math.min(CLIP_AUDIO_GAIN_MAX_DB, Math.max(CLIP_AUDIO_GAIN_MIN_DB, gainDb));
}

/** Linear multiplier for the preview: 0 when muted. */
export function clipAudioScalar(clip: ClipAudioFields): number {
	return clip.audioMuted ? 0 : audioGainScalar(clipAudioGainDb(clip));
}

/** A muted clip reaches native as `hasAudio: false` — the export already renders that as
 *  silence without decoding — and every other clip carries its gain. `hasAudio` stays
 *  optimistic otherwise (see `buildSceneDescription`). */
export function clipAudioExportFields(clip: ClipAudioFields): {
	hasAudio: boolean;
	gainDb: number;
} {
	return { hasAudio: !clip.audioMuted, gainDb: clipAudioGainDb(clip) };
}

export function sameClipAudio(left: ClipAudioFields, right: ClipAudioFields): boolean {
	return clipAudioGainDb(left) === clipAudioGainDb(right) && !left.audioMuted === !right.audioMuted;
}

/** The clip with its audio set; 0 dB and unmuted are stored as absent fields. */
export function withClipAudio<T extends AxcutClip>(
	clip: T,
	audio: { gainDb: number; muted: boolean },
): T {
	const { audioGainDb: _gain, audioMuted: _muted, ...rest } = clip;
	const gainDb = clipAudioGainDb({ audioGainDb: audio.gainDb });
	return {
		...rest,
		...(gainDb !== 0 ? { audioGainDb: gainDb } : {}),
		...(audio.muted ? { audioMuted: true } : {}),
	} as T;
}
