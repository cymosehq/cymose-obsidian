import { describe, it, expect } from "vitest";
import { isCymoseHostedModel, shortModelLabel } from "./models";

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
