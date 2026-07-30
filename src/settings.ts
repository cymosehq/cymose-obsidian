import { App, PluginSettingTab, Setting } from "obsidian";
import type CymosePlugin from "./main";
import type { SyncMap } from "./sync";

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
}

// A sensible default that is cheap, fast and good enough to judge the plugin
// by. Anyone who wants Opus can paste an id; anyone who wants to try the
// plugin should not have to choose a model first.
export const DEFAULT_SETTINGS: CymoseSettings = {
	apiKey: "",
	model: "anthropic/claude-haiku-4.5",
	temperature: 0.7,
	maxTokens: 2048,
	folder: "Cymose",
	systemPrompt:
		"You are part of a branching conversation on a canvas. Answer the current message directly and concisely. Earlier messages are the branch you are on; do not restate them.",
	cymoseApiUrl: "https://api.cymose.cloud",
	cymoseToken: "",
	syncMap: {},
};

// Suggestions, not a whitelist — the field stays free text so a model released
// tomorrow works today without a plugin update.
const SUGGESTED_MODELS = [
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-sonnet-5",
	"openai/gpt-5.6-luna",
	"google/gemini-3.1-flash-lite",
	"deepseek/deepseek-v4-flash",
	"qwen/qwen3-max",
];

export class CymoseSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: CymosePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const notice = containerEl.createDiv({ cls: "cymose-notice" });
		notice.createEl("p", {
			text:
				"0.1 beta. Sign in with a Cymose account and it works on the free tier, with the " +
				"same allowance as the web app; a plan raises it. Bringing your own OpenRouter key " +
				"instead is supported and spends your provider credit rather than Cymose credits.",
		});
		notice.createEl("p", {
			text:
				"Conversations are saved as ordinary Obsidian canvas files in your vault, and nothing " +
				"is stored on our side: a turn is answered and forgotten. They keep working if you " +
				"uninstall this plugin.",
		});

		containerEl.createEl("h3", { text: "Cymose account" });

		new Setting(containerEl)
			.setName("Cymose token")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("From your account page at ");
					frag.createEl("a", { href: "https://cymose.dev", text: "cymose.dev" });
					frag.appendText(
						". The free tier works without paying; a plan raises the limits. This also lets you pull a tree you planned on the web onto a canvas here.",
					);
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("eyJ…")
					.setValue(this.plugin.settings.cymoseToken)
					.onChange(async (value) => {
						this.plugin.settings.cymoseToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h3", { text: "Or bring your own key" });
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

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Any OpenRouter model id. Free text, so a model released tomorrow works today.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.model)
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
						await this.plugin.saveSettings();
					}),
			)
			.addDropdown((drop) => {
				drop.addOption("", "Suggestions…");
				for (const id of SUGGESTED_MODELS) drop.addOption(id, id);
				drop.setValue("");
				drop.onChange(async (value) => {
					if (!value) return;
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Higher wanders further. Branches are usually more interesting above 0.7.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 1.5, 0.1)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
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

		containerEl.createEl("h3", { text: "Advanced" });

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
	}
}
