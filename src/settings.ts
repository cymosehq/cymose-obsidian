import { App, PluginSettingTab, Setting } from "obsidian";
import type CymosePlugin from "./main";

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
				"0.1 beta. Cymose runs on your own OpenRouter key — there is no Cymose account, " +
				"no server of ours in the path, and no telemetry. You pay OpenRouter directly.",
		});
		notice.createEl("p", {
			text:
				"Conversations are saved as ordinary Obsidian canvas files in your vault. " +
				"They keep working if you uninstall this plugin.",
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
