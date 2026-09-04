import { describe, it, expect, vi } from "vitest";

// models.ts imports requestUrl from obsidian at module load. readCatalogue and
// groupByTier never touch it — the mock exists so the import resolves.
vi.mock("obsidian", () => ({ requestUrl: () => Promise.reject(new Error("not used")) }));

import {
	CATALOGUE_VERSION,
	CatalogueError,
	describe as describeModel,
	groupByTier,
	readCatalogue,
	type CatalogueEntry,
} from "./models";

// Loose on purpose: readCatalogue takes `unknown`, and half of what is asserted
// below is what it does with payloads that are the wrong shape.
const entry = (over: Record<string, unknown> = {}) => ({
	id: "openai/gpt-5.6-luna",
	label: "GPT-5.6 Luna",
	maker: "OpenAI",
	tier: "premium",
	credits: 2,
	...over,
});

/** A well-formed entry, for the helpers that take real ones. */
const model = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
	id: "openai/gpt-5.6-luna",
	label: "GPT-5.6 Luna",
	maker: "OpenAI",
	tier: "premium",
	credits: 2,
	...over,
});

describe("readCatalogue", () => {
	it("reads a catalogue from a newer server than this build knows", () => {
		// The point of the change this covers. A server that bumps its format
		// must not blank the model picker in every installed copy of the plugin
		// — which is what an equality check on `version` did, silently, because
		// the caller swallows the error and falls back to a hardcoded list.
		const models = readCatalogue({
			version: CATALOGUE_VERSION + 3,
			models: [entry(), entry({ id: "new/thing", tier: "free", credits: 0, futureField: true })],
		});
		expect(models).toHaveLength(2);
		expect(models[1].id).toBe("new/thing");
	});

	it("reads one from an older server too", () => {
		const models = readCatalogue({ version: 1, models: [entry()] });
		expect(models).toHaveLength(1);
	});

	it("drops an entry whose tier it cannot price, rather than showing it", () => {
		// The failure the version check was really guarding against: a tier this
		// build has no pricing story for must not reach the picker, where it
		// would render under whichever heading happened to sort first.
		const models = readCatalogue({
			version: CATALOGUE_VERSION,
			models: [entry(), entry({ id: "x/y", tier: "enterprise" })],
		});
		expect(models.map((m) => m.id)).toEqual(["openai/gpt-5.6-luna"]);
	});

	it("drops an entry whose credits aren't a number", () => {
		const models = readCatalogue({
			version: CATALOGUE_VERSION,
			models: [entry(), entry({ id: "x/y", credits: "free" }), entry({ id: "x/z", credits: NaN })],
		});
		expect(models.map((m) => m.id)).toEqual(["openai/gpt-5.6-luna"]);
	});

	it("refuses a payload that is not a catalogue at all", () => {
		expect(() => readCatalogue(null)).toThrow(CatalogueError);
		expect(() => readCatalogue({ models: "nope" })).toThrow(CatalogueError);
	});

	it("says the plugin is behind when every entry was unreadable", () => {
		// Distinct from an empty catalogue: the server had models and we could
		// read none of them, which is the one case where "update the plugin" is
		// genuinely the advice.
		expect(() => readCatalogue({ version: 99, models: [{ id: "x" }] })).toThrow(/Updating the plugin/);
		expect(() => readCatalogue({ version: 99, models: [] })).toThrow(/empty catalogue/);
	});
});

describe("groupByTier", () => {
	it("leads with free, because that is the answer to 'what costs me nothing'", () => {
		const groups = groupByTier([
			model({ id: "a", tier: "premium", credits: 10 }),
			model({ id: "b", tier: "free", credits: 0 }),
			model({ id: "c", tier: "standard", credits: 1 }),
		]);
		expect(groups.map((g) => g.tier)).toEqual(["free", "standard", "premium"]);
	});

	it("leaves out a tier nothing is in, rather than an empty heading", () => {
		const groups = groupByTier([model({ tier: "standard", credits: 1 })]);
		expect(groups.map((g) => g.tier)).toEqual(["standard"]);
	});
});

describe("describe", () => {
	it("says a free model costs nothing rather than showing a zero", () => {
		expect(describeModel(model({ tier: "free", credits: 0 }))).toMatch(/free/i);
	});
});
