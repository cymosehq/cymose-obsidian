import { requestUrl } from "obsidian";
import { extractCompletion } from "../models";
import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";

/** OpenAI-compatible chat.completions. Local servers do not stream in Obsidian. */
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

		const payload = {
			model: options.model,
			messages,
			temperature: options.temperature,
			max_tokens: options.maxTokens,
		};

		// fetch SSE to 127.0.0.1 from the Obsidian renderer often never
		// delivers chunks — Ollama finishes, the canvas stays on "…" and Stop.
		// requestUrl waits for the whole JSON body, which is how every other
		// plugin talks to localhost.
		if (this.id === "custom" || isLoopback(base)) {
			yield await completeOnce(`${base}/chat/completions`, headers, payload, signal);
			return;
		}

		const response = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ...payload, stream: true }),
			signal,
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			throw new ProviderError(response.status, extractMessage(text) || response.statusText);
		}

		yield* readOpenAIStream(response.body);
	}
}

function isLoopback(base: string): boolean {
	try {
		const host = new URL(base).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
	} catch {
		return false;
	}
}

async function completeOnce(
	url: string,
	headers: Record<string, string>,
	payload: object,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

	let response;
	try {
		response = await requestUrl({
			url,
			method: "POST",
			headers,
			body: JSON.stringify({ ...payload, stream: false }),
			throw: false,
		});
	} catch (error) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		throw new ProviderError(0, `Couldn't reach the model — ${(error as Error).message}`);
	}

	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	if (response.status >= 400) {
		throw new ProviderError(response.status, extractMessage(response.text) || `HTTP ${response.status}`);
	}

	const text = extractCompletion(response.json) || extractCompletion(tryJson(response.text));
	if (!text.trim()) {
		throw new ProviderError(502, "The model returned an empty answer.");
	}
	return text;
}

function tryJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export async function* readOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const consume = function* (chunk: string): Generator<string> {
		for (const line of chunk.split("\n")) {
			const delta = deltaFromSseLine(line);
			if (delta) yield delta;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			buffer += decoder.decode();
			if (buffer.trim()) {
				const whole = extractCompletion(tryJson(buffer));
				if (whole) {
					yield whole;
					return;
				}
				yield* consume(buffer);
			}
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		yield* consume(lines.join("\n") + "\n");
	}
}

export function deltaFromSseLine(line: string): string {
	if (!line.startsWith("data:")) return "";
	const data = line.slice(5).trim();
	if (!data || data === "[DONE]") return "";
	let event: {
		choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
		error?: { message?: string; code?: number };
	};
	try {
		event = JSON.parse(data) as typeof event;
	} catch {
		return "";
	}
	if (event.error) {
		throw new ProviderError(event.error.code ?? 502, event.error.message ?? "Upstream error");
	}
	return extractCompletion(event);
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
