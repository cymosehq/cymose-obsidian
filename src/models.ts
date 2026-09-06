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
