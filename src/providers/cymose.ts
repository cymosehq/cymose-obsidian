import { ModelAdapter, Message, ModelOptions, ProviderError } from "./types";

// Cymose: turns through your Cymose account.
//
// The default path, and the reason there is an account at all. You sign in
// once, the free tier works with the same allowance as the web app, and a plan
// raises it — no provider key to create, no second bill to reconcile, and the
// same credits whether you're on the canvas in a browser or on a canvas in
// your vault.
//
// Bringing your own key is still supported and is now the *second* path: it
// exists for people who already have an OpenRouter account and would rather
// spend that than credits. See openrouter.ts.
//
// Every turn is ephemeral. The conversation lives in your vault as a .canvas
// file and the server is asked to answer, not to remember: no workspace, no
// stored messages, nothing on our side to go and delete later. The chain of
// ancestors is sent inline as `history`, which is the same thing the web app's
// temporary chats do.

export class CymoseAdapter implements ModelAdapter {
	readonly id = "cymose";

	constructor(
		private baseUrl: string,
		private token: string,
	) {}

	async *chat(messages: Message[], options: ModelOptions): AsyncGenerator<string> {
		if (!this.token.trim()) {
			throw new ProviderError(401, "Not signed in. Sign in to Cymose in settings.");
		}

		// The adapter is handed a whole conversation; the API wants the last
		// user turn as `prompt` and everything before it as `history`. Splitting
		// here keeps the conversation layer from having to know that.
		const history = messages.filter((m) => m.role !== "system");
		const last = history.pop();
		if (!last || last.role !== "user") {
			throw new ProviderError(400, "Nothing to send.");
		}
		const system = messages.find((m) => m.role === "system")?.content;

		const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({
				ephemeral: true,
				prompt: last.content,
				model: options.model,
				history: history.map((m) => ({ role: m.role, content: m.content })),
				system,
				temperature: options.temperature,
			}),
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			let message = text;
			try {
				message = (JSON.parse(text) as { error?: string }).error ?? text;
			} catch {
				// Not JSON — an edge or a proxy answered. The raw body is still
				// better than inventing a sentence.
			}
			throw new ProviderError(response.status, message || "The request failed.");
		}

		// Plain text, not SSE. The web app's chat route streams the answer as it
		// is written, with no framing to unwrap — so the whole of this is: read,
		// decode, yield.
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			// `stream: true` so a multi-byte character split across two reads
			// doesn't become two replacement characters.
			const chunk = decoder.decode(value, { stream: true });
			if (chunk) yield chunk;
		}
	}
}
