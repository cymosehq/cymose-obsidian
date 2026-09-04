import { requestUrl } from "obsidian";

// Which models exist, and what each one costs.
//
// This file deliberately contains no prices. Cymose's tier map and credit
// weights are not ours to publish — this repository is Apache-2.0 and public,
// and a copy of the price list here would be both a leak and a third place for
// it to drift out of date (the API and the web app already hold two). So the
// plugin asks: GET /v1/models, authenticated with the same token that pays for
// a turn, cached in plugin data between openings of the settings tab.
//
// What is hardcoded below is a handful of model *ids*, which are public names
// published by OpenRouter and Cloudflare. They exist for the two situations
// where the catalogue can't be fetched: somebody using their own OpenRouter key
// and no Cymose account, and a first run with no network.

/**
 * Catalogue format this build was written against. Sent by the server as
 * `version`.
 *
 * Advisory, not a gate. This used to be checked for equality and the fetch
 * refused on any mismatch — which meant every server-side bump silently broke
 * the model picker in every installed copy of the plugin, and did it in the
 * worst way: `refreshCatalogue` swallows the error, so an account holder just
 * quietly got the hardcoded OpenRouter fallback list instead of their tiers,
 * with the free models missing entirely and nothing on screen to say why. It
 * had already happened — this build read v1 while the API served v5.
 *
 * A plugin ships through a store and updates on the user's schedule; a version
 * equality check hands the server a switch that bricks clients it cannot see.
 * What the check was actually protecting against — showing "free" beside a
 * model that costs ten credits — is protected properly below, by validating
 * every entry we intend to display.
 */
export const CATALOGUE_VERSION = 6;

export type ModelTier = "free" | "standard" | "premium";

export type CatalogueEntry = {
	id: string;
	label: string;
	maker: string;
	tier: ModelTier;
	/** Credits one turn costs in that tier's pool. Zero means free. */
	credits: number;
};

/**
 * Ids to offer when there is no catalogue to show.
 *
 * OpenRouter ids only, and that is not an oversight: this list is what somebody
 * on their own key sees, and Cymose's free models run on Cloudflare Workers AI,
 * which OpenRouter has never heard of. Offering them here would produce a
 * dropdown where two thirds of the entries fail.
 */
export const FALLBACK_MODEL_IDS = [
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-sonnet-5",
	"openai/gpt-5.6-luna",
	"google/gemini-3.1-flash-lite",
	"deepseek/deepseek-v4-flash",
	"qwen/qwen3-max",
];

/**
 * Models Cymose serves itself, on Cloudflare's binding.
 *
 * OpenRouter cannot answer these, so a key-only user who has one selected gets
 * a 400 from a vendor that has never heard of the id. Recognising the prefix
 * lets us say that in a sentence instead.
 */
export function isCymoseHostedModel(id: string): boolean {
	return id.trim().startsWith("@cf/");
}

export class CatalogueError extends Error {}

/** Reads the lineup. Throws CatalogueError with something worth showing. */
export async function fetchCatalogue(baseUrl: string, token: string): Promise<CatalogueEntry[]> {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) throw new CatalogueError("No Cymose API address is set.");
	if (!token.trim()) throw new CatalogueError("No Cymose access token is set.");

	let response;
	try {
		// requestUrl rather than fetch, for the same reason sync.ts uses it:
		// Obsidian's helper is not subject to the renderer's CORS rules.
		response = await requestUrl({
			url: `${base}/v1/models`,
			method: "GET",
			headers: { Authorization: `Bearer ${token.trim()}` },
			throw: false,
		});
	} catch (error) {
		throw new CatalogueError(`Couldn't reach Cymose: ${(error as Error).message}`);
	}

	if (response.status === 401) throw new CatalogueError("That access token was rejected.");
	if (response.status >= 400) throw new CatalogueError(`Cymose returned ${response.status}.`);

	return readCatalogue(response.json);
}

/**
 * Turns whatever /v1/models answered into entries we can show, or says why not.
 *
 * Split from the fetch so the parsing contract — the part with the judgement
 * in it — can be tested without a network or an Obsidian runtime.
 *
 * Entries are checked one at a time rather than trusted because a version
 * number matched. An entry we can't read is dropped, not guessed at: the thing
 * worth preventing is showing "free" next to a model that costs ten credits,
 * and a reader that validates what it displays prevents that whatever version
 * the server calls its format.
 */
export function readCatalogue(payload: unknown): CatalogueEntry[] {
	const body = payload as { version?: number; models?: unknown[] } | null;
	if (!body || !Array.isArray(body.models)) throw new CatalogueError("Cymose sent something that isn't a catalogue.");

	const models = body.models.filter(isCatalogueEntry);
	if (!models.length) {
		throw new CatalogueError(
			body.models.length
				? "Cymose sent a catalogue this plugin can't read. Updating the plugin should fix it."
				: "Cymose sent an empty catalogue.",
		);
	}
	return models;
}

/**
 * Is this something we can put in front of somebody and price correctly?
 *
 * Every field the picker renders or bills against has to be the right type. A
 * newer server adding fields we don't know about is fine — extra keys are
 * ignored, which is what lets an older plugin keep working across a format
 * bump instead of falling back to a hardcoded list.
 */
function isCatalogueEntry(value: unknown): value is CatalogueEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		!!entry.id &&
		typeof entry.label === "string" &&
		typeof entry.maker === "string" &&
		typeof entry.tier === "string" &&
		(TIER_ORDER as string[]).includes(entry.tier) &&
		typeof entry.credits === "number" &&
		Number.isFinite(entry.credits)
	);
}

// The tiers, in the order a picker shows them — and the set an entry's `tier`
// has to be one of to be displayable at all. One list, so a tier added on the
// server can never be validated here and then dropped when grouping.
const TIER_ORDER: ModelTier[] = ["free", "standard", "premium"];

const TIER_LABELS: Record<ModelTier, string> = {
	// Free leads, and says why in the group heading rather than in a footnote.
	// It is the answer to "what can I do without paying", and a picker that
	// makes somebody infer that from a zero is a picker that loses them.
	free: "Free — costs no credits",
	standard: "Standard",
	premium: "Premium",
};

export type ModelGroup = { tier: ModelTier; label: string; models: CatalogueEntry[] };

/** The catalogue as a picker wants it: free first, dearest last within a tier. */
export function groupByTier(models: CatalogueEntry[]): ModelGroup[] {
	return TIER_ORDER.map((tier) => ({
		tier,
		label: TIER_LABELS[tier],
		models: models.filter((m) => m.tier === tier).sort((a, b) => a.credits - b.credits),
	})).filter((group) => group.models.length > 0);
}

/** How a model reads in a list: what it is, who made it, what it takes. */
export function describe(model: CatalogueEntry): string {
	const cost = model.credits === 0 ? "free" : `${model.credits} credit${model.credits === 1 ? "" : "s"}`;
	return `${model.label} · ${model.maker} · ${cost}`;
}
