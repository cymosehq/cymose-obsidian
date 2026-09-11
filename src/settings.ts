import { App, PluginSettingTab, Setting } from "obsidian";
import type CymosePlugin from "./main";
import { PROVIDER_LABELS, suggestedModels, type ProviderId } from "./providers/create";

export type { ProviderId };

export interface CymoseSettings {
	provider: ProviderId;
	/** Provider key. Lives in this vault's plugin data. */
	apiKey: string;
	/** OpenAI-compatible base, e.g. http://127.0.0.1:11434/v1 */
	baseUrl: string;
	model: string;
	temperature: number;
	maxTokens: number;
	folder: string;
	/** Composer "Instructions". Sent as the system message. */
	systemPrompt: string;
}

export const DEFAULT_SETTINGS: CymoseSettings = {
	provider: "openrouter",
	apiKey: "",
	baseUrl: "http://127.0.0.1:11434/v1",
	model: "deepseek/deepseek-v4-flash",
	temperature: 0.7,
	maxTokens: 2048,
	folder: "Cymose",
	systemPrompt: "",
};

const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[];

/** Keep only fields this build uses. Older plugin data may still contain a Cymose token. */
export function parseSettings(raw: unknown): CymoseSettings {
	const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const provider = data.provider;
	return {
		provider: PROVIDERS.includes(provider as ProviderId) ? (provider as ProviderId) : DEFAULT_SETTINGS.provider,
		apiKey: typeof data.apiKey === "string" ? data.apiKey : DEFAULT_SETTINGS.apiKey,
		baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : DEFAULT_SETTINGS.baseUrl,
		model: typeof data.model === "string" ? data.model : DEFAULT_SETTINGS.model,
		temperature:
			typeof data.temperature === "number" && Number.isFinite(data.temperature)
				? data.temperature
				: DEFAULT_SETTINGS.temperature,
		maxTokens:
			typeof data.maxTokens === "number" && Number.isFinite(data.maxTokens) && data.maxTokens > 0
				? data.maxTokens
				: DEFAULT_SETTINGS.maxTokens,
		folder: typeof data.folder === "string" ? data.folder : DEFAULT_SETTINGS.folder,
		systemPrompt: typeof data.systemPrompt === "string" ? data.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
	};
}

export class CymoseSettingTab extends PluginSettingTab {
	private keyStatusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private plugin: CymosePlugin,
	) {
		super(app, plugin);
	}

	private setStatus(message: string | null, kind: "ok" | "error" | "pending" = "pending"): void {
		const el = this.keyStatusEl;
		if (!el) return;
		if (!message) {
			el.hide();
			return;
		}
		el.setText(message);
		el.removeClass("cymose-conn-status--ok");
		el.removeClass("cymose-conn-status--error");
		if (kind !== "pending") el.addClass(`cymose-conn-status--${kind}`);
		el.show();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.keyStatusEl = null;
		const s = this.plugin.settings;

		const notice = containerEl.createDiv({ cls: "cymose-notice" });
		notice.createEl("p", {
			text:
				"The canvas is the chat. Click a card, then Send — the reply hangs under it as a child. " +
				"You can also write a card yourself and draw an arrow: that is the same branch. " +
				"Turns go from this vault to the provider you pick. Cymose never sees them.",
		});

		new Setting(containerEl).setName("Provider").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Any text or multimodal model that provider lists. Type the model id in the composer.")
			.addDropdown((drop) => {
				for (const id of PROVIDERS) {
					drop.addOption(id, PROVIDER_LABELS[id]);
				}
				drop.setValue(s.provider);
				drop.onChange(async (value) => {
					s.provider = value as ProviderId;
					const live =
						s.provider === "custom" ? await this.plugin.listModels() : suggestedModels(s.provider);
					if (live.length && !live.includes(s.model)) {
						s.model = live[0];
					}
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (s.provider === "custom") {
			new Setting(containerEl)
				.setName("Base URL")
				.setDesc("OpenAI-compatible chat completions root. Ollama is usually http://127.0.0.1:11434/v1 — then pick a name from `ollama list` in the composer.")
				.addText((text) =>
					text
						.setPlaceholder("http://127.0.0.1:11434/v1")
						.setValue(s.baseUrl)
						.onChange(async (value) => {
							s.baseUrl = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				s.provider === "custom"
					? "Optional for local servers. Stored in this vault's plugin data, unencrypted."
					: "Stored in this vault's plugin data, unencrypted — same as every Obsidian plugin.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder(s.provider === "openrouter" ? "sk-or-v1-…" : "sk-…")
					.setValue(s.apiKey)
					.onChange(async (value) => {
						s.apiKey = value.trim();
						await this.plugin.saveSettings();
						this.setStatus(null);
					});
			});

		new Setting(containerEl)
			.setName("Check the connection")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					this.setStatus("Checking…");
					const result = await this.plugin.testProvider();
					this.setStatus(result.message, result.ok ? "ok" : "error");
				}),
			);

		this.keyStatusEl = containerEl.createEl("p", { cls: "cymose-conn-status" });
		this.keyStatusEl.hide();

		new Setting(containerEl)
			.setName("Conversations folder")
			.setDesc("Where new canvases are created.")
			.addText((text) =>
				text
					.setPlaceholder("Cymose")
					.setValue(s.folder)
					.onChange(async (value) => {
						s.folder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max tokens per answer")
			.addText((text) =>
				text.setValue(String(s.maxTokens)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					s.maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxTokens;
					await this.plugin.saveSettings();
				}),
			);
	}
}
