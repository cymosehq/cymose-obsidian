/** What a picker and a node caption should say. The id stays the wire value. */
export function shortModelLabel(id: string): string {
	const trimmed = id.trim();
	const known: Record<string, string> = {
		"deepseek/deepseek-v4-flash": "DeepSeek Flash",
		"google/gemini-3.1-flash-lite": "Gemini Flash Lite",
		"anthropic/claude-haiku-4.5": "Haiku 4.5",
		"anthropic/claude-sonnet-5": "Sonnet 5",
		"openai/gpt-5.6-luna": "GPT-5.6 Luna",
		"qwen/qwen3-max": "Qwen3 Max",
	};
	if (known[trimmed]) return known[trimmed];
	const slash = trimmed.lastIndexOf("/");
	return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).replace(/-/g, " ");
}

/**
 * Ids Cymose used to serve on Cloudflare. OpenRouter cannot answer them.
 * Kept so a vault that still has one selected gets migrated off it.
 */
export function isCymoseHostedModel(id: string): boolean {
	return id.trim().startsWith("@cf/");
}

/** OpenAI `{ data: [{ id }] }` or Ollama `{ models: [{ name }] }`. */
export function readModelIds(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const body = payload as Record<string, unknown>;
	const from = (entry: unknown, keys: string[]): string => {
		if (!entry || typeof entry !== "object") return "";
		const rec = entry as Record<string, unknown>;
		for (const key of keys) {
			if (typeof rec[key] === "string" && rec[key]) return rec[key] as string;
		}
		return "";
	};
	if (Array.isArray(body.data)) {
		return body.data.map((entry) => from(entry, ["id"])).filter(Boolean);
	}
	if (Array.isArray(body.models)) {
		return body.models.map((entry) => from(entry, ["name", "id", "model"])).filter(Boolean);
	}
	return [];
}

export function explainMissingModel(message: string): string | null {
	if (!/not found/i.test(message) || !/model/i.test(message)) return null;
	return `${message.replace(/\s+/g, " ").trim()} — that name is not on this server. Use an id from the composer list, or \`ollama pull\` it first.`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
				return (part as { text: string }).text;
			}
			return "";
		})
		.join("");
}

/** The assistant text from a non-streaming chat.completions (or Ollama) body. */
export function extractCompletion(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const body = payload as {
		choices?: { message?: { content?: unknown }; text?: unknown; delta?: { content?: unknown } }[];
		message?: { content?: unknown };
		response?: unknown;
		error?: { message?: unknown } | string;
	};
	if (body.error) return "";
	const choice = body.choices?.[0];
	const fromChoice = textFromContent(choice?.message?.content) || textFromContent(choice?.delta?.content);
	if (fromChoice) return fromChoice;
	if (typeof choice?.text === "string" && choice.text) return choice.text;
	const fromMessage = textFromContent(body.message?.content);
	if (fromMessage) return fromMessage;
	if (typeof body.response === "string") return body.response;
	return "";
}
