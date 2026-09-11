import { App, EventRef, FuzzySuggestModal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
	CanvasData,
	COLOR_ASSISTANT,
	COLOR_USER,
	appendNode,
	ancestry,
	branchSince,
	estimateHeight,
	forkPoint,
	label,
	readCanvas,
	removeNode,
	sanitizeCanvasMarkers,
	setPromoted,
	textForModel,
	withModelTag,
	writeCanvas,
} from "./canvas";
import { selectNode, selectedNodeId } from "./canvas-api";
import { Message, ProviderError } from "./providers/types";
import { suggestedModels } from "./providers/create";
import { shortModelLabel } from "./models";
import { stripServerMarkers } from "./markers";
import type CymosePlugin from "./main";

/**
 * The three ways `explore` asks the same question.
 *
 * Not three samples at a high temperature — that gives you three paraphrases of
 * the same idea, which is worth nothing to compare. Three different instructions
 * give three genuinely different answers, and comparing them is the reason this
 * product draws a tree instead of a chat log.
 */
const STRATEGIES = [
	{
		label: "the straight answer",
		nudge:
			"Answer directly and conventionally — the approach most practitioners would reach for first. Say plainly what it costs.",
	},
	{
		label: "another angle",
		nudge:
			"Answer by questioning an assumption built into the question. Name the assumption in one line, then answer the question that is left.",
	},
	{
		label: "the risky one",
		nudge:
			"Give the unconventional answer the other two would not reach — higher ceiling, more ways to go wrong. Be explicit about what it costs and when it would be the wrong call.",
	},
];

const CANVAS_FLUSH_MS = 500;
const STREAM_PLACEHOLDER = "…";
const MAX_NOTE_CHARS = 8000;

const PROMOTE_PROMPT =
	"You are compressing one branch of a branching conversation into the conclusion it reached, " +
	"so that branches opened later at the same point inherit it. At most five short lines. State " +
	"what was decided, what was ruled out, and why, as plain facts. Do not restate the question, " +
	"do not hedge, do not add a heading or a preamble.";

type StreamSink = { push: (partial: string) => void; settle: () => Promise<void> };

type FileViewLike = { file?: TFile; contentEl?: HTMLElement; containerEl: HTMLElement; getViewType(): string };

/** The canvas file a leaf is showing, if any. */
export function canvasFileOf(leaf: WorkspaceLeaf): TFile | null {
	const file = (leaf.view as FileViewLike).file;
	return file instanceof TFile && file.extension === "canvas" ? file : null;
}

/**
 * Composer docked on an Obsidian canvas view.
 *
 * The conversation is the canvas. There is no sidebar thread: you point at a
 * node on the board, type here, and the reply hangs off that node. This class
 * is not an ItemView — it mounts onto the canvas leaf's content and unmounts
 * when that leaf goes away or stops showing a Cymose conversation.
 */
export class CymoseOverlay {
	file: TFile | null = null;
	private data: CanvasData = { nodes: [], edges: [] };
	private parentId: string | null = null;
	private lastSeenSelection: string | null = null;
	private sending = false;
	private streamed = "";
	private abort: AbortController | null = null;
	private stopped = false;

	private root: HTMLElement | null = null;
	private host: HTMLElement | null = null;
	private hintEl!: HTMLElement;
	private setupEl!: HTMLElement;
	private setupText!: HTMLElement;
	private errorBox!: HTMLElement;
	private modelInput!: HTMLInputElement;
	private modelList!: HTMLDataListElement;
	private tempInput!: HTMLInputElement;
	private tempValue!: HTMLElement;
	private instructions!: HTMLTextAreaElement;
	private prompt!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private exploreButton!: HTMLButtonElement;
	private newRootButton!: HTMLButtonElement;

	private refs: EventRef[] = [];
	private poll: number | null = null;

	constructor(
		private plugin: CymosePlugin,
		private leaf: WorkspaceLeaf,
	) {}

	private get app(): App {
		return this.plugin.app;
	}

	mount(): void {
		this.detach();
		const view = this.leaf.view as FileViewLike;
		const host = view.contentEl ?? (view.containerEl.querySelector(".view-content") as HTMLElement | null);
		if (!host) return;
		this.host = host;
		host.addClass("cymose-canvas-host");
		this.root = host.createDiv({ cls: "cymose-dock" });
		this.root.addEventListener("mousedown", (event) => event.stopPropagation());
		this.root.addEventListener("pointerdown", (event) => event.stopPropagation());
		this.build(this.root);

		this.refs.push(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.file && file.path === this.file.path && !this.sending) {
					void this.reload();
				}
			}),
		);
		this.poll = window.setInterval(() => {
			if (!this.sending) this.syncSelection();
		}, 500);
	}

	bind(file: TFile): void {
		if (!this.root?.isConnected) this.mount();
		if (this.file?.path === file.path) {
			this.refreshSetup();
			return;
		}
		this.file = file;
		void this.reload();
	}

	detach(): void {
		for (const ref of this.refs) this.app.vault.offref(ref);
		this.refs = [];
		if (this.poll !== null) {
			window.clearInterval(this.poll);
			this.poll = null;
		}
		this.root?.remove();
		this.root = null;
		this.host?.removeClass("cymose-canvas-host");
		this.host = null;
		this.file = null;
	}

	private build(root: HTMLElement): void {
		this.setupEl = root.createDiv({ cls: "cymose-setup" });
		this.setupText = this.setupEl.createDiv({ cls: "cymose-setup-text" });
		const setupBtn = this.setupEl.createEl("button", { cls: "mod-cta cymose-setup-btn", text: "Open settings" });
		setupBtn.onclick = () => this.openPluginSettings();

		this.errorBox = root.createDiv({ cls: "cymose-error" });
		this.errorBox.hide();

		const meta = root.createDiv({ cls: "cymose-dock-meta" });
		this.hintEl = meta.createDiv({ cls: "cymose-dock-hint", text: "Ask anything — it becomes a node." });
		const metaActions = meta.createDiv({ cls: "cymose-dock-actions" });
		this.newRootButton = metaActions.createEl("button", { cls: "cymose-ghost-btn", text: "New root" });
		this.newRootButton.title = "Don't reply under a card. Start another thread on this canvas.";
		this.newRootButton.onclick = () => this.setTarget(null);

		const composer = root.createDiv({ cls: "cymose-composer" });
		this.instructions = composer.createEl("textarea", { cls: "cymose-instructions" });
		this.instructions.rows = 1;
		this.instructions.placeholder = "Instructions (optional) — how the model should answer on this canvas";
		this.instructions.title = "How the model should answer. Sent as the system message.";
		this.instructions.value = this.plugin.settings.systemPrompt;
		this.instructions.addEventListener("change", () => {
			this.plugin.settings.systemPrompt = this.instructions.value;
			void this.plugin.saveSettings();
		});

		this.prompt = composer.createEl("textarea", { cls: "cymose-prompt" });
		this.prompt.rows = 2;
		this.prompt.placeholder = "Select a card to reply under it, or start a new root…";
		this.prompt.addEventListener("input", () => this.fitPrompt());
		this.prompt.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.abort) {
				event.preventDefault();
				this.abort.abort();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void this.explore();
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void this.send();
			}
		});

		const bar = composer.createDiv({ cls: "cymose-composer-bar" });
		this.modelInput = bar.createEl("input", { cls: "cymose-model-input" });
		this.modelInput.type = "text";
		this.modelInput.placeholder = "Model id";
		this.modelList = composer.createEl("datalist");
		this.modelList.id = `cymose-model-suggestions-${Math.random().toString(36).slice(2)}`;
		this.modelInput.setAttr("list", this.modelList.id);
		this.modelInput.setAttr("aria-label", "Model for this turn");
		this.modelInput.title = "Any text or multimodal model id this provider accepts.";
		this.modelInput.addEventListener("change", () => void this.chooseModel(this.modelInput.value.trim()));
		this.populateModels();

		const tempWrap = bar.createDiv({ cls: "cymose-temp" });
		tempWrap.createSpan({ cls: "cymose-temp-label", text: "Temp" });
		this.tempInput = tempWrap.createEl("input");
		this.tempInput.type = "range";
		this.tempInput.min = "0";
		this.tempInput.max = "2";
		this.tempInput.step = "0.1";
		this.tempInput.setAttr("aria-label", "Temperature");
		this.tempValue = tempWrap.createSpan({ cls: "cymose-temp-value" });
		this.syncTemperature();
		this.tempInput.addEventListener("input", () => {
			this.plugin.settings.temperature = Number.parseFloat(this.tempInput.value);
			this.tempValue.setText(this.plugin.settings.temperature.toFixed(1));
		});
		this.tempInput.addEventListener("change", () => void this.plugin.saveSettings());

		this.exploreButton = bar.createEl("button", { cls: "cymose-ghost-btn", text: "Explore 3" });
		this.exploreButton.title = "⌘/Ctrl+Enter — three different answers under this question.";
		this.exploreButton.onclick = () => void this.explore();

		this.sendButton = bar.createEl("button", { cls: "mod-cta cymose-send-btn", text: "Send" });
		this.sendButton.title = "Enter to send · Shift+Enter for a new line";
		this.sendButton.onclick = () => void this.send();

		this.stopButton = bar.createEl("button", { cls: "mod-warning cymose-send-btn", text: "Stop" });
		this.stopButton.title = "Stop. What already streamed is kept.";
		this.stopButton.onclick = () => this.abort?.abort();
		this.stopButton.hide();

		this.refreshSetup();
		this.refreshHint();
	}

	focusPrompt(): void {
		this.prompt?.focus();
	}

	setTarget(id: string | null): void {
		this.parentId = id;
		if (id) this.lastSeenSelection = id;
		this.refreshHint();
	}

	private async reload(): Promise<void> {
		if (!this.file) return;
		try {
			this.data = await readCanvas(this.app.vault, this.file);
			if (sanitizeCanvasMarkers(this.data)) {
				await writeCanvas(this.app.vault, this.file, this.data);
			}
		} catch (error) {
			this.showError((error as Error).message);
			return;
		}
		this.dropStaleTarget();
		this.syncSelection();
		this.populateModels();
		this.refreshSetup();
		this.refreshHint();
	}

	private syncSelection(): void {
		const selected = selectedNodeId(this.app);
		if (!selected || selected === this.lastSeenSelection) return;
		this.lastSeenSelection = selected;
		if (!this.data.nodes.some((n) => n.id === selected)) return;
		this.parentId = selected;
		this.refreshHint();
	}

	/** Keep a reply target only if that card still exists. Never invent one. */
	private dropStaleTarget(): void {
		if (!this.parentId) return;
		if (!this.data.nodes.some((n) => n.id === this.parentId)) this.parentId = null;
	}

	private refreshHint(): void {
		if (!this.hintEl) return;
		const node = this.parentId ? this.data.nodes.find((n) => n.id === this.parentId) : null;
		if (!node) {
			this.hintEl.setText(
				this.data.nodes.length
					? "New root — Send adds a new thread. Click a card to reply under it."
					: "Send creates the first card. Click a card later to reply under it.",
			);
		} else {
			this.hintEl.setText(`Reply under “${label(node, 48)}”`);
		}
		if (this.newRootButton) this.newRootButton.disabled = !this.parentId || this.sending;
	}

	private populateModels(): void {
		if (!this.modelInput || !this.modelList) return;
		const { model, provider } = this.plugin.settings;
		if (provider === "custom") {
			this.modelInput.placeholder = "id from ollama list";
			void this.plugin.listModels().then((ids) => this.fillModelList(ids, model));
			return;
		}
		this.modelInput.placeholder = "Model id";
		this.fillModelList(suggestedModels(provider), model);
	}

	private fillModelList(ids: string[], model: string): void {
		if (!this.modelInput || !this.modelList) return;
		this.modelList.empty();
		const known = new Set<string>();
		for (const id of ids) {
			this.modelList.createEl("option", { value: id, text: shortModelLabel(id) });
			known.add(id);
		}
		if (model && !known.has(model)) {
			this.modelList.createEl("option", { value: model });
		}
		if (document.activeElement !== this.modelInput) this.modelInput.value = model;
		if (ids.length && model && !known.has(model) && (model.includes("/") || model === "llama3.2")) {
			this.plugin.settings.model = ids[0];
			this.modelInput.value = ids[0];
			void this.plugin.saveSettings();
		}
	}

	private syncTemperature(): void {
		if (!this.tempInput || !this.tempValue) return;
		const t = this.plugin.settings.temperature;
		this.tempInput.value = String(t);
		this.tempValue.setText(t.toFixed(1));
	}

	private async chooseModel(id: string): Promise<void> {
		if (!id) return;
		this.plugin.settings.model = id;
		await this.plugin.saveSettings();
	}

	private modelLabel(id: string): string {
		return shortModelLabel(id);
	}

	private fitPrompt(): void {
		this.prompt.style.height = "auto";
		this.prompt.style.height = `${Math.min(this.prompt.scrollHeight, 160)}px`;
	}

	/** Settings changed while this dock is already mounted. */
	onSettingsChanged(): void {
		this.refreshSetup();
	}

	private refreshSetup(): void {
		if (!this.setupEl) return;
		const needs = this.plugin.needsSetup();
		this.setupEl.toggleClass("is-hidden", !needs);
		this.setupText.setText(
			this.plugin.settings.provider === "custom"
				? "Add the server address in settings to send. Local Ollama does not need a key."
				: "Add a provider key to send. Turns go from this vault to that provider — Cymose never sees them.",
		);
		// Missing credentials only block Send. Locking the prompt made the
		// first visit look broken: you open settings, pick Ollama, come back,
		// and still cannot type because this dock never re-checked.
		this.prompt.disabled = this.sending;
		this.modelInput.disabled = this.sending;
		this.tempInput.disabled = this.sending;
		this.instructions.disabled = this.sending;
		this.sendButton.disabled = needs || this.sending;
		this.exploreButton.disabled = needs || this.sending;
		if (this.newRootButton) this.newRootButton.disabled = !this.parentId || this.sending;
		if (document.activeElement !== this.modelInput) this.populateModels();
		this.syncTemperature();
		if (!this.sending && this.instructions && document.activeElement !== this.instructions) {
			this.instructions.value = this.plugin.settings.systemPrompt;
		}
	}

	private openPluginSettings(): void {
		const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(this.plugin.manifest.id);
	}

	private showError(message: string): void {
		this.errorBox.empty();
		this.errorBox.createDiv({ cls: "cymose-error-text", text: message });
		const dismiss = this.errorBox.createEl("button", {
			cls: "cymose-ghost-btn cymose-error-dismiss",
			text: "Dismiss",
		});
		dismiss.onclick = () => this.clearError();
		this.errorBox.show();
	}

	private clearError(): void {
		this.errorBox.empty();
		this.errorBox.hide();
	}

	private begin(): void {
		this.sending = true;
		this.stopped = false;
		this.clearError();
		this.sendButton.hide();
		this.exploreButton.disabled = true;
		this.newRootButton.disabled = true;
		this.prompt.disabled = true;
		this.modelInput.disabled = true;
		this.tempInput.disabled = true;
		this.instructions.disabled = true;
		this.stopButton.setText("Stop");
		this.stopButton.disabled = false;
		this.stopButton.show();
	}

	private end(): void {
		this.sending = false;
		this.sendButton.show();
		this.stopButton.hide();
		this.stopButton.setText("Stop");
		this.refreshSetup();
		this.refreshHint();
	}

	private captureComposer(): void {
		const id = this.modelInput?.value.trim();
		if (id) this.plugin.settings.model = id;
		if (this.instructions) this.plugin.settings.systemPrompt = this.instructions.value;
		const t = Number.parseFloat(this.tempInput?.value ?? "");
		if (Number.isFinite(t)) this.plugin.settings.temperature = t;
		void this.plugin.saveSettings();
	}

	private async ready(): Promise<boolean> {
		if (this.sending) return false;
		if (!this.file) return false;
		this.captureComposer();
		if (this.plugin.needsSetup()) {
			this.refreshSetup();
			this.openPluginSettings();
			new Notice("Cymose: finish setup in settings — a key, or a local server address.");
			return false;
		}
		return true;
	}

	private fail(error: unknown): void {
		const message = error instanceof ProviderError ? error.friendly : (error as Error).message;
		new Notice(`Cymose: ${message}`, 8000);
		this.showError(message);
	}

	private async patchCanvas(file: TFile, change: (data: CanvasData) => void): Promise<void> {
		const data = await readCanvas(this.app.vault, file);
		change(data);
		await writeCanvas(this.app.vault, file, data);
	}

	private async writeNodeText(file: TFile, nodeId: string, text: string): Promise<void> {
		await this.patchCanvas(file, (data) => {
			const node = data.nodes.find((n) => n.id === nodeId);
			if (!node) return;
			node.text = text;
			node.height = estimateHeight(text);
		});
	}

	private canvasSink(file: TFile, nodeId: string, prefix = ""): StreamSink {
		let inFlight: Promise<void> = Promise.resolve();
		let busy = false;
		let last = 0;
		return {
			push: (partial) => {
				const now = Date.now();
				if (busy || now - last < CANVAS_FLUSH_MS) return;
				busy = true;
				last = now;
				const body = stripServerMarkers(partial).trim();
				inFlight = this.writeNodeText(file, nodeId, prefix + (body || STREAM_PLACEHOLDER))
					.catch(() => undefined)
					.then(() => {
						busy = false;
					});
			},
			settle: () => inFlight,
		};
	}

	private async streamTurn(messages: Message[], model: string, sink?: StreamSink): Promise<string> {
		this.streamed = "";
		const controller = new AbortController();
		this.abort = controller;
		try {
			for await (const chunk of this.plugin.adapter().chat(messages, {
				model,
				temperature: this.plugin.settings.temperature,
				maxTokens: this.plugin.settings.maxTokens,
			}, controller.signal)) {
				this.streamed += chunk;
				sink?.push(this.streamed);
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				this.stopped = true;
			} else {
				throw error;
			}
		} finally {
			this.abort = null;
		}
		await sink?.settle();
		return stripServerMarkers(this.streamed).trim();
	}

	private async send(): Promise<void> {
		const text = this.prompt.value.trim();
		if (!text) return;
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		const usedModel = this.plugin.settings.model;
		let answerId: string | null = null;
		this.begin();
		try {
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			const answerNode = appendNode(this.data, question.id, STREAM_PLACEHOLDER, COLOR_ASSISTANT);
			answerId = answerNode.id;
			await writeCanvas(this.app.vault, file, this.data);
			selectNode(this.app, answerNode.id);

			const messages = await this.buildMessages(question.id);
			const streamed = await this.streamTurn(messages, usedModel, this.canvasSink(file, answerNode.id));

			if (this.stopped && !streamed) {
				await this.patchCanvas(file, (data) => removeNode(data, answerNode.id));
				new Notice("Cymose: stopped. Your question is on the canvas.");
				await this.reload();
				this.setTarget(question.id);
				return;
			}
			const answer = streamed
				? withModelTag(streamed, this.modelLabel(usedModel))
				: "_(the model returned nothing)_";
			await this.writeNodeText(file, answerNode.id, answer);
			if (this.stopped) new Notice("Cymose: stopped — kept the partial answer.");

			this.prompt.value = "";
			this.fitPrompt();
			await this.reload();
			this.setTarget(answerNode.id);
			selectNode(this.app, answerNode.id);
		} catch (error) {
			this.fail(error);
			if (answerId) await this.salvage(file, answerId, usedModel);
			await this.reload();
		} finally {
			this.end();
		}
	}

	private async salvage(file: TFile, nodeId: string, model: string): Promise<void> {
		const partial = stripServerMarkers(this.streamed).trim();
		try {
			if (partial) {
				await this.writeNodeText(file, nodeId, withModelTag(partial, this.modelLabel(model)));
			} else {
				await this.patchCanvas(file, (data) => removeNode(data, nodeId));
			}
		} catch {
			/* already failing */
		}
	}

	async explore(): Promise<void> {
		const text = this.prompt.value.trim();
		if (!text) {
			new Notice("Cymose: type the question you want asked three ways.");
			return;
		}
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		const usedModel = this.plugin.settings.model;
		this.begin();
		try {
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			await writeCanvas(this.app.vault, file, this.data);

			const base = await this.buildMessages(question.id);
			let written = 0;

			for (const [index, strategy] of STRATEGIES.entries()) {
				this.stopButton.setText(`${index + 1}/3`);
				const caption = `_${strategy.label}_\n\n`;
				this.data = await readCanvas(this.app.vault, file);
				const branch = appendNode(this.data, question.id, caption + STREAM_PLACEHOLDER, COLOR_ASSISTANT);
				await writeCanvas(this.app.vault, file, this.data);
				selectNode(this.app, branch.id);

				let answer: string;
				try {
					answer = await this.streamTurn(
						this.withNudge(base, strategy.nudge),
						usedModel,
						this.canvasSink(file, branch.id, caption),
					);
				} catch (error) {
					this.fail(error);
					await this.salvage(file, branch.id, usedModel);
					break;
				}
				if (answer) {
					await this.writeNodeText(file, branch.id, withModelTag(caption + answer, this.modelLabel(usedModel)));
					written += 1;
				} else {
					await this.patchCanvas(file, (data) => removeNode(data, branch.id));
				}
				if (this.stopped) break;
			}

			this.prompt.value = "";
			this.fitPrompt();
			await this.reload();
			this.setTarget(question.id);
			selectNode(this.app, question.id);
			if (written) {
				new Notice(`Cymose: ${written} branch${written === 1 ? "" : "es"} off that question.`);
			}
		} catch (error) {
			this.fail(error);
		} finally {
			this.end();
		}
	}

	async promote(): Promise<void> {
		const tipId = this.parentId;
		if (!tipId) {
			new Notice("Cymose: select the tip of the branch you want promoted.");
			return;
		}
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		this.begin();
		try {
			this.data = await readCanvas(this.app.vault, file);
			const tip = this.data.nodes.find((n) => n.id === tipId);
			const target = forkPoint(this.data, tipId);
			if (!tip || !target || target.id === tipId) {
				new Notice("Cymose: there is nothing above this branch to promote into.");
				return;
			}

			const branch = branchSince(this.data, target.id, tipId);
			const transcript = branch
				.map((node) => {
					const body = textForModel(node.text ?? "");
					if (!body) return "";
					return `${node.color === COLOR_ASSISTANT ? "Answer" : "Question"}: ${body}`;
				})
				.filter(Boolean)
				.join("\n\n");
			if (!transcript) {
				new Notice("Cymose: that branch is empty.");
				return;
			}

			const targetLabel = label(target, 40);
			const tipLabel = label(tip, 40);

			const digest = await this.streamTurn(
				[
					{ role: "system", content: PROMOTE_PROMPT },
					{ role: "user", content: transcript },
				],
				this.plugin.settings.model,
			);
			if (this.stopped) {
				new Notice("Cymose: promotion stopped — nothing written.");
				return;
			}
			if (!digest) {
				new Notice("Cymose: the model returned nothing to promote.");
				return;
			}

			this.data = await readCanvas(this.app.vault, file);
			const fresh = this.data.nodes.find((n) => n.id === target.id);
			if (!fresh) {
				new Notice("Cymose: the node to promote into is gone.");
				return;
			}
			setPromoted(fresh, tipId, tipLabel, digest);
			await writeCanvas(this.app.vault, file, this.data);
			await this.reload();
			new Notice(`Cymose: promoted into “${targetLabel}”. Branches opened there inherit it.`);
		} catch (error) {
			this.fail(error);
		} finally {
			this.end();
		}
	}

	async pinNote(): Promise<void> {
		if (this.sending) return;
		const nodeId = this.parentId;
		if (!this.file || !nodeId) {
			new Notice("Cymose: select the node you want the note pinned to.");
			return;
		}
		const file = this.file;
		const notes = this.app.vault.getMarkdownFiles();
		if (!notes.length) {
			new Notice("Cymose: this vault has no notes to pin yet.");
			return;
		}

		new NotePicker(this.app, notes, async (note) => {
			try {
				this.data = await readCanvas(this.app.vault, file);
				const node = this.data.nodes.find((n) => n.id === nodeId);
				if (!node) {
					new Notice("Cymose: that node is gone.");
					return;
				}
				const embed = `![[${note.basename}]]`;
				if ((node.text ?? "").includes(embed)) {
					new Notice(`Cymose: “${note.basename}” is already pinned there.`);
					return;
				}
				node.text = `${(node.text ?? "").trimEnd()}\n\n${embed}`.trim();
				node.height = estimateHeight(node.text);
				await writeCanvas(this.app.vault, file, this.data);
				await this.reload();
				new Notice(`Cymose: pinned “${note.basename}”. Every branch below it reads it.`);
			} catch (error) {
				this.fail(error);
			}
		}).open();
	}

	private withNudge(base: Message[], nudge: string): Message[] {
		const messages = base.slice();
		if (messages[0]?.role === "system") {
			messages[0] = { role: "system", content: `${messages[0].content}\n\n${nudge}` };
		} else {
			messages.unshift({ role: "system", content: nudge });
		}
		return messages;
	}

	private async buildMessages(fromNodeId: string): Promise<Message[]> {
		const chain = ancestry(this.data, fromNodeId);
		const messages: Message[] = [];
		if (this.plugin.settings.systemPrompt.trim()) {
			messages.push({ role: "system", content: this.plugin.settings.systemPrompt.trim() });
		}
		for (const node of chain) {
			const content = await this.resolveEmbeds(textForModel(node.text ?? ""));
			if (!content.trim()) continue;
			messages.push({
				role: node.color === COLOR_ASSISTANT ? "assistant" : "user",
				content,
			});
		}
		return messages;
	}

	private async resolveEmbeds(text: string): Promise<string> {
		const embeds = [...text.matchAll(/!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)];
		if (!embeds.length) return text;

		let out = text;
		for (const match of embeds) {
			const target = this.app.metadataCache.getFirstLinkpathDest(
				match[1].trim(),
				this.file?.path ?? "",
			);
			if (!(target instanceof TFile) || target.extension !== "md") continue;

			let body: string;
			try {
				body = await this.app.vault.cachedRead(target);
			} catch {
				continue;
			}
			const clipped =
				body.length > MAX_NOTE_CHARS
					? `${body.slice(0, MAX_NOTE_CHARS)}\n…(note truncated)`
					: body;
			out = out.replace(
				match[0],
				() => `--- note: ${target.basename} ---\n${clipped.trim()}\n--- end of note ---`,
			);
		}
		return out;
	}
}

class NotePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private notes: TFile[],
		private onPick: (note: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Pin which note?");
	}

	getItems(): TFile[] {
		return this.notes;
	}

	getItemText(note: TFile): string {
		return note.path;
	}

	onChooseItem(note: TFile): void {
		this.onPick(note);
	}
}
