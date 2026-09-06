import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";
import { extractMessage } from "./openai-compat";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

export class AnthropicAdapter implements ModelAdapter {
	readonly id = "anthropic";

	constructor(private apiKey: string) {}

	async *chat(messages: Message[], options: ModelOptions, signal?: AbortSignal): AsyncGenerator<string> {
		if (!this.apiKey.trim()) {
			throw new ProviderError(401, "No Anthropic key set. Add one in Cymose settings.");
		}

		const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
		const rest = messages.filter((m) => m.role !== "system");

		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey.trim(),
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: options.model,
				system: system || undefined,
				messages: rest,
				temperature: options.temperature,
				max_tokens: Math.max(1, options.maxTokens),
				stream: true,
			}),
			signal,
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			throw new ProviderError(response.status, extractMessage(text) || response.statusText);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				let event: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
				try {
					event = JSON.parse(data) as typeof event;
				} catch {
					continue;
				}
				if (event.type === "error") {
					throw new ProviderError(502, event.error?.message ?? "Anthropic error");
				}
				if (event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text;
			}
		}
	}
}
