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

/** Catalogue format this build reads. Sent by the server as `version`. */
export const CATALOGUE_VERSION = 1;

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

	const body = response.json as { version?: number; models?: CatalogueEntry[] };
	if (!body || !Array.isArray(body.models)) throw new CatalogueError("Cymose sent something that isn't a catalogue.");

	// A build that meets a format it doesn't know refuses rather than guesses.
	// Mis-reading a tier would mean showing somebody "free" next to a model that
	// costs ten credits, and they would find out by running out.
	if (body.version !== CATALOGUE_VERSION) {
		throw new CatalogueError(
			`This plugin reads catalogue v${CATALOGUE_VERSION}; Cymose sent v${body.version}. Update the plugin.`,
		);
	}
	return body.models;
}

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
