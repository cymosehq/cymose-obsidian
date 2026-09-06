import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";
import { OpenAICompatAdapter } from "./openai-compat";
import { isCymoseHostedModel } from "../models";

/** OpenRouter: one key, every model they list. Same wire as OpenAI. */
export class OpenRouterAdapter implements ModelAdapter {
	readonly id = "openrouter";
	private inner: OpenAICompatAdapter;

	constructor(apiKey: string) {
		this.inner = new OpenAICompatAdapter({
			id: "openrouter",
			apiKey,
			baseUrl: "https://openrouter.ai/api/v1",
			label: "OpenRouter",
			extraHeaders: {
				"HTTP-Referer": "https://cymose.app",
				"X-Title": "Cymose for Obsidian",
			},
		});
	}

	async *chat(messages: Message[], options: ModelOptions, signal?: AbortSignal): AsyncGenerator<string> {
		if (isCymoseHostedModel(options.model)) {
			throw new ProviderError(
				400,
				`“${options.model}” is not an OpenRouter model. Type any OpenRouter model id.`,
			);
		}
		yield* this.inner.chat(messages, options, signal);
	}
}
