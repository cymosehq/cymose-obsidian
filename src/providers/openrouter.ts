import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";
import { isCymoseHostedModel } from "../models";

// OpenRouter: one key, every model.
//
// Chosen as the only provider in 0.1 because it is the shortest path to the
// multi-model promise — Claude, GPT, Gemini, DeepSeek, Qwen, Kimi, GLM and the
// rest behind a single OpenAI-compatible endpoint and a single key the user
// already has to paste once. Adding a direct Anthropic or OpenAI adapter later
// is a new file behind ModelAdapter, not a change to anything above it.
//
// Requests go from the user's machine straight to OpenRouter. No server of
// ours is involved, and the key never leaves the vault's settings file.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterAdapter implements ModelAdapter {
	readonly id = "openrouter";

	constructor(private apiKey: string) {}

	async *chat(messages: Message[], options: ModelOptions): AsyncGenerator<string> {
		if (!this.apiKey.trim()) {
			throw new ProviderError(401, "No OpenRouter key set. Add one in Cymose settings.");
		}
		// The default model is one of Cymose's free ones, which run on
		// Cloudflare's binding and do not exist at OpenRouter. Left alone this
		// reaches them as an unknown id and comes back as a 400 naming a model
		// the user never typed. Say it here instead — and say it rather than
		// silently substituting something, because quietly answering on a model
		// nobody chose is how a bill becomes a surprise.
		if (isCymoseHostedModel(options.model)) {
			throw new ProviderError(
				400,
				`“${options.model}” is a Cymose-hosted model and OpenRouter can't answer it. Pick an OpenRouter model in Cymose settings.`,
			);
		}

		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
				// Attribution on OpenRouter's public leaderboard. Optional, free.
				"HTTP-Referer": "https://cymose.app",
				"X-Title": "Cymose for Obsidian",
			},
			body: JSON.stringify({
				model: options.model,
				messages,
				temperature: options.temperature,
				max_tokens: options.maxTokens,
				stream: true,
			}),
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

			// SSE frames are separated by a blank line, but a chunk can split one
			// anywhere — so keep the tail until the next read completes it.
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;

				let event: {
					choices?: { delta?: { content?: string } }[];
					error?: { message?: string; code?: number };
				};
				try {
					event = JSON.parse(data);
				} catch {
					continue; // a malformed frame is not worth failing the turn over
				}

				// A provider that dies after the 200 reports it inside the stream
				// rather than as a status. Surface it as the same kind of error.
				if (event.error) {
					throw new ProviderError(event.error.code ?? 502, event.error.message ?? "Upstream error");
				}

				const delta = event.choices?.[0]?.delta?.content;
				if (delta) yield delta;
			}
		}
	}
}

/** Pulls a human message out of an error body, whatever shape it arrived in. */
function extractMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } | string };
		if (typeof parsed.error === "string") return parsed.error;
		return parsed.error?.message ?? "";
	} catch {
		return body.slice(0, 200);
	}
}
