import {
	BaseChatModel,
	type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { runCopilot } from "../copilot";
import { messageContentToText } from "./chat-model";

/** Text-only path for caption translation and conversation compaction. */
export class CopilotChatModel extends BaseChatModel {
	constructor(private readonly model: string) {
		super({});
	}

	_llmType() {
		return "github-copilot-sdk";
	}

	async _generate(messages: BaseMessage[], options: BaseChatModelCallOptions): Promise<ChatResult> {
		const system = messages
			.filter((message) => message.getType() === "system")
			.map((message) => messageContentToText(message.content))
			.join("\n");
		const prompt = messages
			.filter((message) => message.getType() !== "system")
			.map((message) => messageContentToText(message.content))
			.join("\n");
		const text = await runCopilot({ model: this.model, system, prompt, signal: options.signal });
		return { generations: [{ text, message: new AIMessage(text) }] };
	}
}
