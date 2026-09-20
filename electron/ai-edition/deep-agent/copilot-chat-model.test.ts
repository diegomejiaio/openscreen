import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, expect, it, vi } from "vitest";
import { runCopilot } from "../copilot";
import { createOpenScreenChatModel } from "./chat-model";

vi.mock("../copilot", () => ({ runCopilot: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it("routes text transforms through Copilot without editor tools or an API key", async () => {
	vi.mocked(runCopilot).mockResolvedValue("Hola");
	const model = await createOpenScreenChatModel({
		provider: "github-copilot",
		model: "test",
	});
	const result = await model.invoke([
		new SystemMessage("Translate to Spanish"),
		new HumanMessage("Hello"),
	]);
	expect(result.content).toBe("Hola");
	expect(runCopilot).toHaveBeenCalledWith({
		model: "test",
		system: "Translate to Spanish",
		prompt: "Hello",
		signal: undefined,
	});
});

it("propagates authentication errors instead of returning a successful empty translation", async () => {
	vi.mocked(runCopilot).mockRejectedValue(new Error("Please sign in"));
	const model = await createOpenScreenChatModel({
		provider: "github-copilot",
		model: "test",
	});
	await expect(model.invoke("Hello")).rejects.toThrow("Please sign in");
});
