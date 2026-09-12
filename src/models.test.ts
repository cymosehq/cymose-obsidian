import { describe, it, expect } from "vitest";
import { explainMissingModel, extractCompletion, isCymoseHostedModel, readModelIds, shortModelLabel } from "./models";

describe("shortModelLabel", () => {
	it("uses a short name for known ids and the last path segment otherwise", () => {
		expect(shortModelLabel("deepseek/deepseek-v4-flash")).toBe("DeepSeek Flash");
		expect(shortModelLabel("vendor/some-new-model")).toBe("some new model");
	});
});

describe("isCymoseHostedModel", () => {
	it("recognises the old Cloudflare Workers AI ids", () => {
		expect(isCymoseHostedModel("@cf/meta/llama-3")).toBe(true);
		expect(isCymoseHostedModel("deepseek/deepseek-v4-flash")).toBe(false);
	});
});

describe("readModelIds", () => {
	it("reads OpenAI-compatible lists", () => {
		expect(readModelIds({ data: [{ id: "llama3.2:latest" }, { id: "qwen2.5:7b" }] })).toEqual([
			"llama3.2:latest",
			"qwen2.5:7b",
		]);
	});

	it("reads Ollama /api/tags", () => {
		expect(readModelIds({ models: [{ name: "llama3.2:latest" }, { name: "gemma2:2b" }] })).toEqual([
			"llama3.2:latest",
			"gemma2:2b",
		]);
	});

	it("returns nothing for junk", () => {
		expect(readModelIds(null)).toEqual([]);
		expect(readModelIds({ data: "nope" })).toEqual([]);
	});
});

describe("explainMissingModel", () => {
	it("tells you to pull or pick a name the server has", () => {
		const text = explainMissingModel("model 'llama3.2' not found");
		expect(text).toMatch(/ollama pull/);
		expect(text).toMatch(/llama3\.2/);
	});
});

describe("extractCompletion", () => {
	it("reads OpenAI chat.completions", () => {
		expect(extractCompletion({ choices: [{ message: { content: "hello" } }] })).toBe("hello");
	});

	it("reads Ollama's native chat body", () => {
		expect(extractCompletion({ message: { content: "привет" } })).toBe("привет");
	});
});
