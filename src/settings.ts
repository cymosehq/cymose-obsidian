import { App, PluginSettingTab, Setting } from "obsidian";
import type CymosePlugin from "./main";
import type { SyncMap } from "./sync";
import {
	FALLBACK_MODEL_IDS,
	fetchCatalogue,
	groupByTier,
	describe,
	isCymoseHostedModel,
	type CatalogueEntry,
} from "./models";

export interface CymoseSettings {
	/** OpenRouter key. Lives in this vault's plugin data, never leaves it
	 *  except to OpenRouter itself. */
	apiKey: string;
	model: string;
	temperature: number;
	maxTokens: number;
	/** Where new conversations are created. */
	folder: string;
	/** Prepended to every conversation. Empty means none. */
	systemPrompt: string;
	/** Cymose API address. Only used by the tree pull; empty disables it. */
	cymoseApiUrl: string;
	/** Cymose access token, for reading your web tree. Never sent anywhere else. */
	cymoseToken: string;
	/** Which canvas node mirrors which Cymose node, per canvas path. See sync.ts. */
	syncMap: SyncMap;
	/** Last catalogue read from GET /v1/models. Empty until one is fetched. */
	modelCatalogue: CatalogueEntry[];
	/** When it was read, so the tab doesn't ask on every open. */
	modelCatalogueAt: number;
}

/** How long a cached catalogue is trusted. The lineup changes in weeks. */
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

// The default costs no credits.
//
// It used to be Claude Haiku, which is a metered model — so a new user signed
// in, pressed "Explore 3 ways", and three metered turns came out of an
// allowance they had not been told they were spending. On the web the free
// Cloudflare models are what the picker leads with and what a free account
// actually runs on; there was no reason for the plugin to disagree, and every
// reason not to, since the first five minutes decide whether there is a sixth.
//
// Anyone who wants Sonnet can pick it in two clicks. Nobody should have to
// choose a model, or read a price list, before their first question.
export const DEFAULT_SETTINGS: CymoseSettings = {
	apiKey: "",
	model: "@cf/openai/gpt-oss-120b",
	temperature: 0.7,
	maxTokens: 2048,
	folder: "Cymose",
	systemPrompt:
		"You are part of a branching conversation on a canvas. Answer the current message directly and concisely. Earlier messages are the branch you are on; do not restate them.",
	cymoseApiUrl: "https://api.cymose.app",
	cymoseToken: "",
	syncMap: {},
	modelCatalogue: [],
	modelCatalogueAt: 0,
};

export class CymoseSettingTab extends PluginSettingTab {
	/** Where the connection test writes its answer. Recreated on each display(). */
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private plugin: CymosePlugin,
	) {
		super(app, plugin);
	}

	private setStatus(message: string | null, kind: "ok" | "error" | "pending" = "pending"): void {
		const el = this.statusEl;
		if (!el) return;
		if (!message) {
			el.hide();
			return;
		}
		el.setText(message);
		el.removeClass("cymose-status--ok");
		el.removeClass("cymose-status--error");
		if (kind !== "pending") el.addClass(`cymose-status--${kind}`);
		el.show();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.statusEl = null;

		const notice = containerEl.createDiv({ cls: "cymose-notice" });
		notice.createEl("p", {
			text:
				"Paste a Cymose token below and it works on the free tier, with the " +
				"same allowance as the web app; a plan raises it. Bringing your own OpenRouter key " +
				"instead is supported and spends your provider credit rather than Cymose credits.",
		});
		notice.createEl("p", {
			text:
				"Conversations are saved as ordinary Obsidian canvas files in your vault, and keep " +
				"working if you uninstall this plugin. A turn is sent to whichever service you " +
				"configured below — Cymose, or OpenRouter on your own key — and neither one keeps a " +
				"copy of it: Cymose answers the request and stores nothing but the credits it cost.",
		});

		new Setting(containerEl).setName("Cymose account").setHeading();

		// Where the token comes from, in the order you have to do it.
		//
		// The previous wording said "from your account page at cymose.app". There
		// was no account page, and the closest thing to a token was the Supabase
		// session sitting in devtools — which expires in an hour. So the
		// documented route was impossible, the discoverable one broke before
		// lunch, and the plugin looked broken to everyone who tried either.
		const steps = containerEl.createEl("ol", { cls: "cymose-steps" });
		steps.createEl("li").append(
			createFragment((frag) => {
				frag.appendText("Open ");
				frag.createEl("a", { href: "https://chat.cymose.app", text: "chat.cymose.app" });
				frag.appendText(" and sign in (or create a free account).");
			}),
		);
		steps.createEl("li", { text: "Go to Settings → Connected apps." });
		steps.createEl("li", { text: "Create a token, name it something like “Obsidian”, and copy it." });
		steps.createEl("li", { text: "Paste it below. It's shown once, so paste it before closing that page." });

		new Setting(containerEl)
			.setName("Cymose token")
			.setDesc(
				"Starts with cym_. It doesn't expire — it works until you revoke it on that same page.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("cym_…")
					.setValue(this.plugin.settings.cymoseToken)
					.onChange(async (value) => {
						this.plugin.settings.cymoseToken = value.trim();
						await this.plugin.saveSettings();
						// Any status shown is about the token that was there a
						// keystroke ago, and a stale green tick next to a token that
						// no longer works is worse than no tick.
						this.setStatus(null);
					});
			});

		// "Did that work?" answered here, before the first question is asked.
		//
		// Without this the first sign that a token is wrong is a failed turn,
		// which reports a provider error — so a mistyped credential looks like a
		// broken model, and the setting people go back to change is the wrong one.
		new Setting(containerEl)
			.setName("Check the connection")
			.setDesc("Asks Cymose who you are and what your allowance is. Costs nothing.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					this.setStatus("Checking…");
					const result = await this.plugin.testConnection();
					this.setStatus(result.message, result.ok ? "ok" : "error");
				}),
			);

		this.statusEl = containerEl.createEl("p", { cls: "cymose-status" });
		this.statusEl.hide();

		new Setting(containerEl).setName("Or bring your own key").setHeading();
		containerEl.createEl("p", {
			cls: "cymose-notice",
			text:
				"Set a key here and turns go straight to OpenRouter on your account instead of spending " +
				"Cymose credits. Leave it empty to use your Cymose account.",
		});

		new Setting(containerEl)
			.setName("OpenRouter API key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("Get one at ");
					frag.createEl("a", { href: "https://openrouter.ai/keys", text: "openrouter.ai/keys" });
					frag.appendText(". Stored in this vault's plugin data, unencrypted — the same place every Obsidian plugin keeps its settings.");
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-or-v1-…")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		this.modelSetting(containerEl);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Higher wanders further. Branches are usually more interesting above 0.7.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 1.5, 0.1)
					.setValue(this.plugin.settings.temperature)
					.onChange(async (value) => {
						this.plugin.settings.temperature = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max tokens per answer")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxTokens))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						// A bad number would otherwise become NaN and fail the next
						// turn with a provider error that explains nothing.
						this.plugin.settings.maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxTokens;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Conversations folder")
			.setDesc("Where new canvases are created.")
			.addText((text) =>
				text
					.setPlaceholder("Cymose")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Cymose API address")
			.setDesc("Only change this if you are pointing at your own deployment.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.cymoseApiUrl)
					.setValue(this.plugin.settings.cymoseApiUrl)
					.onChange(async (value) => {
						this.plugin.settings.cymoseApiUrl = value.trim() || DEFAULT_SETTINGS.cymoseApiUrl;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Sent at the top of every branch.")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
			});

		// Kicked off after the tab is drawn, not before: a slow network should
		// delay the catalogue, never the settings screen. It re-renders if it
		// finds something new.
		void this.refreshCatalogue();
	}

	/**
	 * Which model answers, and what it will take out of your allowance.
	 *
	 * The costs come from the server, never from this repository — see models.ts
	 * for why. When there is no catalogue to show (own key, or a first run
	 * offline) the dropdown falls back to bare ids, which is exactly what this
	 * setting offered before and no worse than it was.
	 */
	private modelSetting(containerEl: HTMLElement): void {
		const { model, modelCatalogue, cymoseToken, apiKey } = this.plugin.settings;
		const usingOwnKey = !cymoseToken.trim() && Boolean(apiKey.trim());
		// A catalogue is only meaningful for turns Cymose is billing. On somebody
		// else's key the tiers are ours and the bill is OpenRouter's, so showing
		// our credit weights there would be describing a charge that never happens.
		const catalogue = usingOwnKey ? [] : modelCatalogue;

		const setting = new Setting(containerEl)
			.setName("Model")
			.setDesc(
				catalogue.length
					? "Free models cost no credits, on any plan. Free text as well, so a model released tomorrow works today."
					: "Any model id. Free text, so a model released tomorrow works today.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.model)
					.setValue(model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
						await this.plugin.saveSettings();
					}),
			)
			.addDropdown((drop) => {
				drop.addOption("", catalogue.length ? "Pick a model…" : "Suggestions…");

				if (catalogue.length) {
					// Obsidian's dropdown has no group API, so the optgroups are
					// built on its select directly. Worth it: three tiers in one
					// flat list is a wall of names with numbers after them.
					for (const group of groupByTier(catalogue)) {
						const optgroup = drop.selectEl.createEl("optgroup");
						optgroup.label = group.label;
						for (const entry of group.models) {
							optgroup.createEl("option", { value: entry.id, text: describe(entry) });
						}
					}
				} else {
					for (const id of FALLBACK_MODEL_IDS) drop.addOption(id, id);
				}

				drop.setValue("");
				drop.onChange(async (value) => {
					if (!value) return;
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		// The one combination that fails outright, said here rather than after a
		// turn is refused: Cymose's free models run on Cloudflare's binding, and
		// OpenRouter has never heard of them.
		if (usingOwnKey && isCymoseHostedModel(model)) {
			setting.descEl.createEl("p", {
				cls: "cymose-warning",
				text: `“${model}” is a Cymose-hosted model and OpenRouter can't answer it. Pick one from the list, or sign in to Cymose above.`,
			});
		}
	}

	/**
	 * Reads the lineup from the API, at most once a day.
	 *
	 * Failure is silent on purpose. This decorates a picker that already works
	 * without it, and somebody who opened settings to paste a token should not
	 * be met with an error about a list they had not asked for.
	 */
	private async refreshCatalogue(): Promise<void> {
		const { cymoseToken, cymoseApiUrl, modelCatalogueAt, modelCatalogue } = this.plugin.settings;
		if (!cymoseToken.trim()) return;
		if (modelCatalogue.length && Date.now() - modelCatalogueAt < CATALOGUE_TTL_MS) return;

		try {
			const models = await fetchCatalogue(cymoseApiUrl, cymoseToken);
			this.plugin.settings.modelCatalogue = models;
			this.plugin.settings.modelCatalogueAt = Date.now();
			await this.plugin.saveSettings();
			// Guard against redrawing a tab the user has already closed.
			if (this.containerEl.isConnected) this.display();
		} catch {
			// Keep whatever was cached, and the fallback ids if there is nothing.
		}
	}
}
