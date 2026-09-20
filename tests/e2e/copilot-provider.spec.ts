import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type {
	AiEditionChatResult,
	NativeBridgeRequest,
	NativeBridgeResponse,
} from "../../src/native/contracts";

test("Copilot desktop provider uses local login and only editor tools", async () => {
	test.setTimeout(180_000);
	test.skip(
		process.env.OPENSCREEN_COPILOT_SMOKE !== "1",
		"Opt-in: requires local GitHub authentication.",
	);
	const profile = await mkdtemp(path.join(tmpdir(), "openscreen-copilot-e2e-"));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.ELECTRON_RUN_AS_NODE;
	if (process.env.OPENSCREEN_TEST_EXECUTABLE && process.platform === "darwin") {
		// Finder does not inherit Homebrew's PATH from the terminal.
		env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	}
	const app = await electron.launch({
		...(process.env.OPENSCREEN_TEST_EXECUTABLE
			? { executablePath: process.env.OPENSCREEN_TEST_EXECUTABLE }
			: {}),
		args: [
			...(process.env.OPENSCREEN_TEST_EXECUTABLE ? [] : [path.resolve("dist-electron/main.js")]),
			`--user-data-dir=${profile}`,
		],
		env,
	});
	app.process().stderr?.on("data", (data) => console.error(String(data)));
	app.process().stdout?.on("data", (data) => console.log(String(data)));
	try {
		expect(await realpath(await app.evaluate(({ app }) => app.getPath("userData")))).toBe(
			await realpath(profile),
		);
		const hud = await app.firstWindow();
		await hud.waitForFunction(() => Boolean(window.electronAPI?.switchToEditor));
		const [page] = await Promise.all([
			app.waitForEvent("window"),
			hud.evaluate(() => {
				void window.electronAPI.switchToEditor();
			}),
		]);
		await page.waitForFunction(() => Boolean(window.electronAPI?.invokeNativeBridge));
		const call = <T>(request: NativeBridgeRequest) =>
			page
				.evaluate(async (request) => {
					return window.electronAPI.invokeNativeBridge(request);
				}, request)
				.then((response) => {
					const envelope = response as NativeBridgeResponse<T>;
					if (!envelope.ok) throw new Error(JSON.stringify(envelope));
					return envelope.data;
				});
		const models = await call<{ models: string[]; error?: string }>({
			domain: "aiEdition",
			action: "llm.listProviderModels",
			payload: { providerId: "github-copilot" },
		});
		expect(models.error).toBeUndefined();
		expect(models.models).toContain("gpt-5.4-mini");
		if (process.env.OPENSCREEN_TEST_EXECUTABLE) {
			expect(await app.evaluate(({ app }) => app.getName())).toBe("Openscreen Copilot");
		}
		const saved = await call<{ success: boolean; error?: string }>({
			domain: "aiEdition",
			action: "llm.setConfig",
			payload: {
				config: { provider: "github-copilot", model: "gpt-5.4-mini", allowAgentEdits: true },
			},
		});
		expect(saved).toEqual({ success: true });
		await page.getByRole("button", { name: /OpenScreen/ }).click();
		await page.getByRole("menuitem", { name: /AI settings/i }).click();
		await page.getByRole("button", { name: /GitHub Copilot/ }).click();
		await expect(page.getByRole("heading", { name: "GitHub Copilot" })).toBeVisible();
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(
			page.locator("select").filter({ has: page.locator('option[value="gpt-5.4-mini"]') }),
		).toBeVisible();
		await page.screenshot({ path: test.info().outputPath("openscreen-copilot.png") });
		const permission = page.getByRole("switch", { name: "Allow the agent to edit the project" });
		await permission.focus();
		await page.keyboard.press("Space");
		await expect(permission).not.toBeChecked();
		await page.keyboard.press("Space");
		await expect(permission).toBeChecked();
		for (const viewport of [
			{ width: 1280, height: 800, theme: "light" },
			{ width: 900, height: 700, theme: "dark" },
			{ width: 390, height: 844, theme: "light" },
		]) {
			await page.setViewportSize(viewport);
			await page.evaluate((theme) => {
				window.document.documentElement.dataset.theme = theme;
				window.document.documentElement.classList.toggle("dark", theme === "dark");
			}, viewport.theme);
			const model = page.getByRole("combobox", { name: "Model", exact: true });
			await expect(model).toBeVisible();
			const label = page.locator(`label[for="${await model.getAttribute("id")}"]`);
			const labelBox = await label.boundingBox();
			const modelBox = await model.boundingBox();
			expect(labelBox && modelBox && labelBox.y + labelBox.height <= modelBox.y).toBe(true);
			expect(
				await page
					.locator('[class*="providerForm"]')
					.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);
			await page.screenshot({
				path: test.info().outputPath(`copilot-settings-${viewport.width}-${viewport.theme}.png`),
			});
		}

		const base = createEmptyDocument({ title: "Copilot smoke test", projectId: "copilot-smoke" });
		const document = documentSchema.parse({
			...base,
			project: { ...base.project, primaryAssetId: "test-video" },
			assets: [
				{
					id: "test-video",
					kind: "video",
					label: "Synthetic clip",
					originalPath: "synthetic.mp4",
					durationSec: 10,
				},
			],
			timeline: {
				clips: [
					{
						id: "test-clip",
						assetId: "test-video",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 10,
						origin: "user",
						reason: "Test",
					},
				],
			},
		});
		if (process.env.OPENSCREEN_COPILOT_LIVE === "1") {
			const session = await call<{ id: string }>({
				domain: "aiEdition",
				action: "chat.createSession",
				payload: { projectId: "copilot-smoke", title: "Copilot smoke test" },
			});
			const result = await call<AiEditionChatResult>({
				domain: "aiEdition",
				action: "chat.run",
				payload: {
					projectId: "copilot-smoke",
					sessionId: session.id,
					document,
					message:
						"Read the current document, then add one annotation with the exact text COPILOT_OK from second 1 to second 3. Do not make any other edits.",
				},
			});
			expect(result.success, JSON.stringify(result)).toBe(true);
			const edited = documentSchema.parse(result.document);
			expect(edited.annotations).toHaveLength(1);
			expect(edited.annotations[0]).toMatchObject({
				content: "COPILOT_OK",
				startMs: 1000,
				endMs: 3000,
			});
			expect(edited.timeline).toEqual(document.timeline);
			expect(result.toolCalls?.some((tool) => tool.name === "addAnnotation")).toBe(true);
		}
	} finally {
		await app.close();
		await rm(profile, { recursive: true, force: true });
	}
});
