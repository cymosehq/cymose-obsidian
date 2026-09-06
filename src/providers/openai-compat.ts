import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";

/** OpenAI-compatible chat.completions streaming. One dialect, many vendors. */
export class OpenAICompatAdapter implements ModelAdapter {
	readonly id: string;

	constructor(
		private opts: {
			id: string;
			apiKey: string;
			baseUrl: string;
			extraHeaders?: Record<string, string>;
			label: string;
		},
	) {
		this.id = opts.id;
	}

	async *chat(messages: Message[], options: ModelOptions, signal?: AbortSignal): AsyncGenerator<string> {
		const base = this.opts.baseUrl.trim().replace(/\/+$/, "");
		if (!base) {
			throw new ProviderError(400, "No API base URL set. Add one in Cymose settings.");
		}
		if (!this.opts.apiKey.trim() && this.id !== "custom") {
			throw new ProviderError(401, `No ${this.opts.label} key set. Add one in Cymose settings.`);
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...this.opts.extraHeaders,
		};
		if (this.opts.apiKey.trim()) headers.Authorization = `Bearer ${this.opts.apiKey.trim()}`;

		const response = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: options.model,
				messages,
				temperature: options.temperature,
				max_tokens: options.maxTokens,
				stream: true,
			}),
			signal,
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			throw new ProviderError(response.status, extractMessage(text) || response.statusText);
		}

		yield* readOpenAIStream(response.body);
	}
}

export async function* readOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
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

			let event: {
				choices?: { delta?: { content?: string | { text?: string }[] } }[];
				error?: { message?: string; code?: number };
			};
			try {
				event = JSON.parse(data) as typeof event;
			} catch {
				continue;
			}
			if (event.error) {
				throw new ProviderError(event.error.code ?? 502, event.error.message ?? "Upstream error");
			}
			const raw = event.choices?.[0]?.delta?.content;
			const delta = typeof raw === "string" ? raw : raw?.map((part) => part.text ?? "").join("");
			if (delta) yield delta;
		}
	}
}

export function extractMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } | string };
		if (typeof parsed.error === "string") return parsed.error;
		return parsed.error?.message ?? "";
	} catch {
		return body.slice(0, 200);
	}
}
