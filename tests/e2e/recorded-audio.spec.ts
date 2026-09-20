import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type {
	AiEditionDocumentResult,
	NativeBridgeRequest,
	NativeBridgeResponse,
} from "../../src/native/contracts";

const RATE = 48_000;
const PROJECT_ID = "recorded-audio-e2e";
type App = Awaited<ReturnType<typeof electron.launch>>;

function ffmpeg(args: string[]) {
	return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
		maxBuffer: 8 * 1024 * 1024,
	});
}

function decodeAudio(file: string) {
	const bytes = ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]);
	return Float32Array.from({ length: bytes.length / 4 }, (_, index) =>
		bytes.readFloatLE(index * 4),
	);
}

// Project onto one frequency so retained programme audio cannot masquerade as narration.
function amplitude(pcm: Float32Array, frequency: number, start: number, duration = 0.2) {
	const first = Math.round(start * RATE);
	const count = Math.round(duration * RATE);
	expect(first + count).toBeLessThanOrEqual(pcm.length);
	let sine = 0;
	let cosine = 0;
	for (let i = 0; i < count; i++) {
		const phase = (2 * Math.PI * frequency * i) / RATE;
		sine += pcm[first + i] * Math.sin(phase);
		cosine += pcm[first + i] * Math.cos(phase);
	}
	return (2 * Math.hypot(sine, cosine)) / count;
}

async function documentCall(page: Page, request: NativeBridgeRequest) {
	const result = (await page.evaluate(
		(request) => window.electronAPI.invokeNativeBridge(request),
		request,
	)) as NativeBridgeResponse<AiEditionDocumentResult>;
	if (!result.ok) throw new Error(JSON.stringify(result));
	expect(result.data.success, JSON.stringify(result.data)).toBe(true);
	return documentSchema.parse(result.data.document);
}

function readDocument(page: Page) {
	return documentCall(page, {
		domain: "aiEdition",
		action: "document.get",
		payload: { projectId: PROJECT_ID },
	});
}

async function launch(profile: string, scratch: string) {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		args: [path.resolve("dist-electron/main.js"), `--user-data-dir=${profile}`, "--lang=en-US"],
		env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
	});
	try {
		expect(await realpath(await app.evaluate(({ app }) => app.getPath("userData")))).toBe(
			await realpath(profile),
		);
		const hud = await app.firstWindow();
		await hud.waitForFunction(() => Boolean(window.electronAPI?.switchToEditor));
		const [page] = await Promise.all([
			app.waitForEvent("window"),
			hud
				.evaluate(() => {
					void window.electronAPI.switchToEditor();
				})
				.catch((error: unknown) => {
					// The main process can destroy the HUD before CDP acknowledges this evaluation.
					if (
						!hud.isClosed() ||
						!(error instanceof Error) ||
						!error.message.includes("Target page, context or browser has been closed")
					) {
						throw error;
					}
				}),
		]);
		await page.waitForFunction(() => Boolean(window.electronAPI?.invokeNativeBridge));
		await page.setViewportSize({ width: 1280, height: 900 });
		return { app, page };
	} catch (error) {
		await app.close();
		throw error;
	}
}

for (const format of ["m4a", "wav"] as const) {
	test(`${format} voiceover imports, aligns, persists and mixes into native MP4`, async () => {
		test.setTimeout(180_000);
		test.skip(
			process.env.OPENSCREEN_RECORDED_AUDIO_E2E !== "1",
			"Opt-in: built Electron app, matching native compositor and local FFmpeg/ffprobe required.",
		);
		const scratch = await mkdtemp(path.join(tmpdir(), "openscreen-recorded-audio-"));
		const profile = path.join(scratch, "profile");
		const recordings = path.join(profile, "recordings");
		const videoPath = path.join(recordings, "programme.mp4");
		// Outside userData: reopening must restore approval, not rely on the recordings root.
		const audioPath = path.join(scratch, `recorded-voice.${format}`);
		const outputPath = test.info().outputPath("mixed.mp4");
		let app: App | undefined;
		try {
			await mkdir(recordings, { recursive: true });
			ffmpeg([
				"-f",
				"lavfi",
				"-i",
				"color=c=0x243b53:s=640x360:r=30:d=8",
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=0.04*sin(2*PI*220*t):s=48000:d=8",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-shortest",
				videoPath,
			]);
			ffmpeg([
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=0.24*sin(2*PI*if(lt(t\\,2)\\,880\\,1320)*t):s=48000:d=3",
				"-c:a",
				format === "m4a" ? "aac" : "pcm_s16le",
				...(format === "m4a" ? ["-b:a", "192k"] : []),
				audioPath,
			]);
			const first = await launch(profile, scratch);
			app = first.app;
			let page = first.page;
			const base = createEmptyDocument({ projectId: PROJECT_ID, title: "Recorded narration" });
			const initial = documentSchema.parse({
				...base,
				project: { ...base.project, primaryAssetId: "programme" },
				assets: [
					{
						id: "programme",
						kind: "video",
						label: "Programme",
						originalPath: videoPath,
						durationSec: 8,
						video: { codec: "h264", width: 640, height: 360, fps: 30 },
						audio: { codec: "aac", sampleRate: RATE, channels: 1 },
					},
				],
				timeline: {
					clips: [0, 4].map((start, index) => ({
						id: `clip-${index}`,
						assetId: "programme",
						sourceStartSec: start,
						sourceEndSec: start + 4,
						timelineStartSec: start,
						timelineEndSec: start + 4,
						origin: "user",
						reason: "Synthetic two-clip fixture",
					})),
				},
			});
			await documentCall(page, {
				domain: "aiEdition",
				action: "document.save",
				payload: { document: initial },
			});
			await page.reload();
			await expect(page.locator("[data-clip-id]")).toHaveCount(2);

			// Only the OS picker is substituted; its IPC path approval/import run normally.
			await app.evaluate(({ dialog }, filePath) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
			}, audioPath);
			const ruler = page.locator('[class*="tlRulerRow"] [class*="tlCanvas"]');
			const rulerBox = await ruler.boundingBox();
			if (!rulerBox) throw new Error("Timeline ruler is not visible");
			await ruler.click({ position: { x: rulerBox.width / 8, y: 8 } });
			await page.keyboard.press("v");
			await page.getByRole("button", { name: "Import audio file", exact: true }).click();
			const pill = page.locator('[role="button"][class*="laneAudio"]').filter({
				hasText: `recorded-voice.${format}`,
			});
			await expect(pill).toBeVisible();
			await expect(pill.locator('[class*="tlWave"] span').first()).toBeVisible();
			const imported = await readDocument(page);
			expect(imported.assets.filter((asset) => asset.kind === "audio")).toHaveLength(1);
			expect(imported.audioTracks[0].kind).toBe("voiceover");
			expect(imported.audioTracks[0].startMs / 1000).toBeCloseTo(1, 1);

			const pillBox = await pill.boundingBox();
			if (!pillBox) throw new Error("Imported audio pill is not visible");
			await page.mouse.move(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(
				pillBox.x + pillBox.width / 2 + rulerBox.width / 8,
				pillBox.y + pillBox.height / 2,
				{ steps: 8 },
			);
			await page.mouse.up();
			await expect
				.poll(async () => (await readDocument(page)).audioTracks[0].startMs / 1000)
				.toBeCloseTo(2, 1);

			const edge = pill.locator('[class*="lanePillHandle"]').last();
			const edgeBox = await edge.boundingBox();
			if (!edgeBox) throw new Error("Audio trim handle is not visible");
			await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
			await page.mouse.down();
			await page.mouse.move(
				edgeBox.x + edgeBox.width / 2 - rulerBox.width / 16,
				edgeBox.y + edgeBox.height / 2,
				{ steps: 8 },
			);
			await page.mouse.up();
			await expect
				.poll(async () =>
					Math.max(...(await readDocument(page)).audioTracks.map((track) => track.endMs / 1000)),
				)
				.toBeCloseTo(4.5, 1);

			await pill.focus();
			await page.keyboard.press("Enter");
			const gain = page.getByRole("slider", { name: "Output level", exact: true });
			await gain.focus();
			for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft");
			await expect(gain).toHaveValue("-6");
			await expect
				.poll(async () => (await readDocument(page)).audioTracks.map((track) => track.gainDb))
				.toEqual([-6, -6]);
			const saved = await readDocument(page);
			expect(saved.timeline.clips).toEqual(initial.timeline.clips);
			expect(saved.audioTracks).toHaveLength(2);
			expect(saved.audioTracks[1].offsetMs).toBeCloseTo(
				saved.audioTracks[0].endMs - saved.audioTracks[0].startMs,
				0,
			);
			await page.screenshot({ path: test.info().outputPath("aligned-voiceover.png") });
			await app.close();
			app = undefined;

			const reopened = await launch(profile, scratch);
			app = reopened.app;
			page = reopened.page;
			await expect(page.locator("[data-clip-id]")).toHaveCount(2);
			const restored = await readDocument(page);
			expect(restored.audioTracks).toEqual(saved.audioTracks);
			expect(restored.assets).toEqual(saved.assets);
			expect(restored.timeline.clips).toEqual(initial.timeline.clips);
			await expect(
				page.locator('[class*="laneAudio"] [class*="tlWave"] span').first(),
			).toBeVisible();

			await app.evaluate(({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			}, outputPath);
			await page.getByRole("button", { name: "Export", exact: true }).click();
			const exportDialog = page.getByRole("dialog");
			await exportDialog.getByRole("button", { name: "MP4", exact: true }).click();
			await exportDialog.getByRole("button", { name: "Export MP4", exact: true }).click();
			await expect(exportDialog.getByText("Saved to")).toBeVisible({
				timeout: 90_000,
			});
			await expect(exportDialog.getByText(outputPath, { exact: true })).toBeVisible();

			const pcm = decodeAudio(outputPath);
			const source = decodeAudio(audioPath);
			const programme = decodeAudio(videoPath);
			const start = saved.audioTracks[0].startMs / 1000;
			const end = saved.audioTracks[1].endMs / 1000;
			const gainDb =
				20 * Math.log10(amplitude(pcm, 880, start + 0.3) / amplitude(source, 880, 0.3));
			expect(Math.abs(gainDb + 6)).toBeLessThan(1.5);
			for (const time of [0.5, start + 0.3, 4.1, 6]) {
				const differenceDb =
					20 * Math.log10(amplitude(pcm, 220, time) / amplitude(programme, 220, time));
				expect(Math.abs(differenceDb), `Programme audio at ${time}s`).toBeLessThan(1.5);
			}
			// The second tone proves source offset continuity across the video cut.
			expect(amplitude(pcm, 1320, start + 2.1)).toBeGreaterThan(0.08);
			expect(amplitude(pcm, 880, start + 2.1)).toBeLessThan(0.01);
			for (const time of [0.5, start - 0.3, end + 0.1, 7]) {
				expect(amplitude(pcm, 880, time)).toBeLessThan(0.005);
				expect(amplitude(pcm, 1320, time)).toBeLessThan(0.005);
			}
			const active: number[] = [];
			for (let sample = 0; sample + 480 <= pcm.length; sample += 480) {
				let energy = 0;
				for (let i = sample; i < sample + 480; i++) energy += pcm[i] ** 2;
				if (Math.sqrt(energy / 480) > 0.055) active.push(sample / RATE);
			}
			expect(active.length).toBeGreaterThan(0);
			const measuredStart = active[0];
			const measuredEnd = active[active.length - 1] + 0.01;
			expect(Math.abs(measuredStart - start)).toBeLessThanOrEqual(1 / 30);
			expect(Math.abs(measuredEnd - end)).toBeLessThanOrEqual(1 / 30);
			const duration = Number(
				execFileSync(
					"ffprobe",
					["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath],
					{ encoding: "utf8" },
				).trim(),
			);
			expect(Math.abs(duration - 8)).toBeLessThanOrEqual(1 / 30);
			const measurementsPath = test.info().outputPath("audio-measurements.json");
			await writeFile(
				measurementsPath,
				JSON.stringify(
					{ format, start, end, measuredStart, measuredEnd, gainDb, duration },
					null,
					2,
				),
			);
			await test.info().attach("audio-measurements", {
				path: measurementsPath,
				contentType: "application/json",
			});
		} finally {
			if (app) await app.close();
			await rm(scratch, { recursive: true, force: true });
		}
	});
}
