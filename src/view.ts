import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
	CanvasData,
	CanvasNode,
	COLOR_ASSISTANT,
	COLOR_USER,
	appendNode,
	ancestry,
	estimateHeight,
	label,
	leaves,
	readCanvas,
	writeCanvas,
} from "./canvas";
import { Message, ProviderError } from "./providers/types";
import type CymosePlugin from "./main";

export const VIEW_TYPE = "cymose-panel";

// The panel you talk to. The canvas is the conversation; this is the place you
// choose where to speak from.
//
// Picking the parent explicitly, rather than reading the canvas selection, is
// deliberate: Obsidian exposes no public API for what's selected on a canvas,
// and reaching into internals means the plugin breaks on an Obsidian release
// for no benefit the user asked for. A dropdown that defaults to the last node
// costs one click and never breaks — and it makes branching visible, which is
// the thing people are here for.
export class CymoseView extends ItemView {
	private file: TFile | null = null;
	private data: CanvasData = { nodes: [], edges: [] };
	private parentId: string | null = null;
	private sending = false;
	private streamed = "";

	private parentSelect!: HTMLSelectElement;
	private prompt!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private preview!: HTMLElement;
	private status!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CymosePlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Cymose";
	}

	getIcon(): string {
		return "git-branch";
	}

	async onOpen(): Promise<void> {
		this.build();
		await this.attachToActiveCanvas();

		// Following the active file is what makes the panel feel part of the
		// app: open a canvas, and the panel is already pointed at it.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => void this.attachToActiveCanvas()),
		);
		// Someone may edit the canvas by hand, or a second window may add a node.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.file && file.path === this.file.path && !this.sending) {
					void this.reload();
				}
			}),
		);
	}

	private build(): void {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cymose-panel");

		this.status = root.createDiv({ cls: "cymose-status" });

		const parentRow = root.createDiv({ cls: "cymose-field" });
		parentRow.createEl("label", { text: "Branch from" });
		this.parentSelect = parentRow.createEl("select", { cls: "dropdown" });
		this.parentSelect.onchange = () => {
			this.parentId = this.parentSelect.value || null;
		};

		const promptRow = root.createDiv({ cls: "cymose-field" });
		promptRow.createEl("label", { text: "Message" });
		this.prompt = promptRow.createEl("textarea", { cls: "cymose-prompt" });
		this.prompt.rows = 6;
		this.prompt.placeholder = "Ask something. It becomes a node under the one you picked.";
		// registerDomEvent, not addEventListener: Obsidian unregisters it with the
		// view. Relying on the element being torn down works today and is the
		// first thing a plugin reviewer asks about.
		this.registerDomEvent(this.prompt, "keydown", (event) => {
			// Enter sends, shift+enter breaks the line — the convention every
			// chat box in the world uses, and the one people try first.
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void this.send();
			}
		});

		const actions = root.createDiv({ cls: "cymose-actions" });
		this.sendButton = actions.createEl("button", { cls: "mod-cta", text: "Send" });
		this.sendButton.onclick = () => void this.send();

		const newButton = actions.createEl("button", { text: "New conversation" });
		newButton.onclick = () => void this.plugin.newConversation();

		this.preview = root.createDiv({ cls: "cymose-preview" });
	}

	/** Points the panel at whatever canvas is in front, if any. */
	private async attachToActiveCanvas(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "canvas") {
			// Keep the previous canvas attached rather than blanking the panel:
			// clicking a note to read it should not lose your place.
			if (!this.file) this.setStatus("Open a canvas, or press “New conversation”.");
			return;
		}
		if (this.file?.path === file.path) return;
		this.file = file;
		await this.reload();
	}

	async openFile(file: TFile): Promise<void> {
		this.file = file;
		await this.reload();
	}

	private async reload(): Promise<void> {
		if (!this.file) return;
		try {
			this.data = await readCanvas(this.app.vault, this.file);
		} catch (error) {
			this.setStatus((error as Error).message);
			return;
		}
		this.refreshParents();
		this.setStatus(`${this.file.basename} · ${this.data.nodes.length} node${this.data.nodes.length === 1 ? "" : "s"}`);
	}

	/**
	 * Rebuilds the parent picker.
	 *
	 * Leaves come first and one is preselected: continuing the conversation is
	 * what you want nine times out of ten, and branching from the middle is the
	 * deliberate act that deserves the extra scroll.
	 */
	private refreshParents(): void {
		const previous = this.parentId;
		this.parentSelect.empty();

		if (this.data.nodes.length === 0) {
			this.parentSelect.createEl("option", { value: "", text: "Start of the conversation" });
			this.parentId = null;
			return;
		}

		const ends = leaves(this.data);
		const endIds = new Set(ends.map((n) => n.id));
		const rest = this.data.nodes.filter((n) => !endIds.has(n.id));

		const addOption = (node: CanvasNode, prefix: string) => {
			this.parentSelect.createEl("option", { value: node.id, text: `${prefix}${label(node)}` });
		};
		for (const node of ends) addOption(node, "→ ");
		for (const node of rest) addOption(node, "⑂ ");
		this.parentSelect.createEl("option", { value: "", text: "— new root —" });

		const stillThere = previous && this.data.nodes.some((n) => n.id === previous);
		this.parentId = stillThere ? previous : (ends[ends.length - 1]?.id ?? null);
		this.parentSelect.value = this.parentId ?? "";
	}

	private setStatus(text: string): void {
		this.status.setText(text);
	}

	/**
	 * One turn: write the question, stream the answer, then write it.
	 *
	 * The answer is streamed into the panel and written to the canvas once, at
	 * the end. Rewriting the file on every chunk would mean a disk write and a
	 * canvas re-render several times a second, which is how you make an editor
	 * feel broken — and the live text is right here while it arrives.
	 */
	private async send(): Promise<void> {
		if (this.sending) return;
		const text = this.prompt.value.trim();
		if (!text) return;

		if (!this.file) {
			await this.plugin.newConversation();
			if (!this.file) return;
		}
		if (!this.plugin.settings.apiKey.trim()) {
			new Notice("Cymose: add your OpenRouter key in settings first.");
			return;
		}

		this.sending = true;
		this.sendButton.disabled = true;
		this.sendButton.setText("Sending…");
		this.streamed = "";
		this.preview.setText("");

		try {
			// Re-read before writing: the file may have changed since the panel
			// last looked, and appending to a stale copy would drop those nodes.
			this.data = await readCanvas(this.app.vault, this.file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			await writeCanvas(this.app.vault, this.file, this.data);

			const messages = this.buildMessages(question.id);
			for await (const chunk of this.plugin.adapter().chat(messages, {
				model: this.plugin.settings.model,
				temperature: this.plugin.settings.temperature,
				maxTokens: this.plugin.settings.maxTokens,
			})) {
				this.streamed += chunk;
				this.preview.setText(this.streamed);
				this.preview.scrollTop = this.preview.scrollHeight;
			}

			const answer = this.streamed.trim() || "_(the model returned nothing)_";
			this.data = await readCanvas(this.app.vault, this.file);
			const node = appendNode(this.data, question.id, answer, COLOR_ASSISTANT);
			node.height = estimateHeight(answer);
			await writeCanvas(this.app.vault, this.file, this.data);

			this.prompt.value = "";
			await this.reload();
			// Continue from the answer, which is where the next question goes.
			this.parentId = node.id;
			this.parentSelect.value = node.id;
		} catch (error) {
			const message = error instanceof ProviderError ? error.friendly : (error as Error).message;
			new Notice(`Cymose: ${message}`, 8000);
			// The question node stays. It cost nothing, it records what was
			// asked, and deleting it would also delete whatever the user typed.
			this.setStatus(message);
		} finally {
			this.sending = false;
			this.sendButton.disabled = false;
			this.sendButton.setText("Send");
		}
	}

	/**
	 * The branch, as messages.
	 *
	 * The chain up to the root is the context — which is what makes a branch a
	 * branch rather than a fresh chat: fork from any node and the new line
	 * inherits everything above it and nothing beside it. Sibling branches stay
	 * invisible to each other, which is the point.
	 *
	 * Roles alternate by colour, because that is what we set when we wrote the
	 * node; a hand-added node has no colour and is treated as the user's, which
	 * is the reading that makes "type a note on the canvas and ask about it"
	 * work.
	 */
	private buildMessages(fromNodeId: string): Message[] {
		const chain = ancestry(this.data, fromNodeId);
		const messages: Message[] = [];
		if (this.plugin.settings.systemPrompt.trim()) {
			messages.push({ role: "system", content: this.plugin.settings.systemPrompt.trim() });
		}
		for (const node of chain) {
			const content = (node.text ?? "").trim();
			if (!content) continue;
			messages.push({
				role: node.color === COLOR_ASSISTANT ? "assistant" : "user",
				content,
			});
		}
		return messages;
	}
}
