import type { ModelAdapter } from "./types";
import { AnthropicAdapter } from "./anthropic";
import { OpenAICompatAdapter } from "./openai-compat";
import { OpenRouterAdapter } from "./openrouter";

export type ProviderId = "openrouter" | "openai" | "anthropic" | "google" | "custom";

export function createAdapter(settings: { provider: ProviderId; apiKey: string; baseUrl: string }): ModelAdapter {
	const key = settings.apiKey;
	switch (settings.provider) {
		case "openai":
			return new OpenAICompatAdapter({
				id: "openai",
				apiKey: key,
				baseUrl: "https://api.openai.com/v1",
				label: "OpenAI",
			});
		case "google":
			return new OpenAICompatAdapter({
				id: "google",
				apiKey: key,
				baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
				label: "Google",
			});
		case "anthropic":
			return new AnthropicAdapter(key);
		case "custom":
			return new OpenAICompatAdapter({
				id: "custom",
				apiKey: key,
				baseUrl: settings.baseUrl,
				label: "this endpoint",
			});
		default:
			return new OpenRouterAdapter(key);
	}
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	openrouter: "OpenRouter",
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	custom: "OpenAI-compatible (Ollama, LM Studio, Groq…)",
};

export const SUGGESTED_MODELS: Record<ProviderId, string[]> = {
	openrouter: [
		"deepseek/deepseek-v4-flash",
		"google/gemini-3.1-flash-lite",
		"anthropic/claude-haiku-4.5",
		"anthropic/claude-sonnet-5",
		"openai/gpt-5.6-luna",
		"qwen/qwen3-max",
	],
	openai: ["gpt-5.4", "gpt-4.1", "gpt-4o", "o4-mini"],
	anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"],
	google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
	custom: ["llama3.2", "qwen2.5", "gpt-4o"],
};

export function suggestedModels(provider: ProviderId): string[] {
	return SUGGESTED_MODELS[provider] ?? SUGGESTED_MODELS.openrouter;
}
