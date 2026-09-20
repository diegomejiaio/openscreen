import { beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument, documentSchema } from "../../../src/lib/ai-edition/schema";
import { OPENSCREEN_TOOL_NAMES } from "../agent-tools";
import { runCopilot } from "../copilot";
import { invokeOpenScreenAgent, type OpenScreenAgentSink } from "./service";

vi.mock("../copilot", () => ({ runCopilot: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

function fixture() {
	const base = createEmptyDocument({ title: "Test", projectId: "copilot-test" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "video" },
		assets: [
			{
				id: "video",
				kind: "video",
				label: "Synthetic clip",
				originalPath: "synthetic.mp4",
				durationSec: 10,
			},
		],
		timeline: {
			clips: [
				{
					id: "clip",
					assetId: "video",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					origin: "user",
				},
			],
		},
	});
}

function sink(): OpenScreenAgentSink {
	return { text: vi.fn(), thinking: vi.fn(), toolStart: vi.fn(), toolEnd: vi.fn(), error: vi.fn() };
}

it.each([
	true,
	false,
])("retains editor tool validation and edit consent (%s)", async (editsAllowed) => {
	const document = fixture();
	const events = sink();
	vi.mocked(runCopilot).mockImplementation(async (options) => {
		expect(options.tools?.map((tool) => tool.name)).toEqual(OPENSCREEN_TOOL_NAMES);
		const tool = options.tools?.find((tool) => tool.name === "addAnnotation");
		if (!tool) throw new Error("Missing annotation tool");
		const handler = tool.handler;
		if (!handler) throw new Error("Missing annotation handler");
		expect(tool.parameters).toMatchObject({ type: "object" });
		await Promise.all(
			["first", "second"].map((text) =>
				handler(
					{ startSec: 1, endSec: 3, text },
					{
						sessionId: "test",
						toolCallId: text,
						toolName: tool.name,
						arguments: { startSec: 1, endSec: 3, text },
					},
				),
			),
		);
		options.onText?.("Done");
		return "Done";
	});
	const result = await invokeOpenScreenAgent({
		document,
		model: { provider: "github-copilot", model: "test" },
		history: [],
		userMessage: "Add annotations",
		editsAllowed,
		sink: events,
	});
	expect(result.reason).toBeUndefined();
	expect(result.mutated).toBe(editsAllowed);
	expect(result.document.annotations.map((annotation) => annotation.content)).toEqual(
		editsAllowed ? ["first", "second"] : [],
	);
	expect(result.document.timeline).toEqual(document.timeline);
	expect(document.annotations).toEqual([]);
	expect(events.text).toHaveBeenCalledWith("Done");
	expect(events.toolEnd).toHaveBeenCalledWith(
		"addAnnotation",
		editsAllowed,
		editsAllowed ? expect.anything() : undefined,
	);
});

it("returns the original document and surfaces a failed Copilot turn", async () => {
	const document = fixture();
	const events = sink();
	vi.mocked(runCopilot).mockRejectedValue(new Error("Copilot unavailable"));
	const result = await invokeOpenScreenAgent({
		document,
		model: { provider: "github-copilot", model: "test" },
		history: [],
		userMessage: "Add annotation",
		sink: events,
	});
	expect(result).toMatchObject({
		document,
		mutated: false,
		text: "",
		reason: "Copilot unavailable",
	});
	expect(events.error).toHaveBeenCalledWith("Copilot unavailable");
});
