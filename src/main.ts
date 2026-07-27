import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CymoseSettingTab, CymoseSettings, DEFAULT_SETTINGS } from "./settings";
import { OpenRouterAdapter } from "./providers/openrouter";
import type { ModelAdapter } from "./providers/types";
import { CymoseView, VIEW_TYPE } from "./view";
import { appendNode, COLOR_USER, createCanvas, readCanvas, writeCanvas } from "./canvas";

// Cymose for Obsidian — 0.1 beta.
//
// Every AI plugin for Obsidian puts a linear chat in a sidebar. The
// interesting conversations are not linear: you want to ask the same question
// three ways, keep the answer that held up, and still be able to find the two
// that didn't and why.
//
// So a conversation here is an ordinary Obsidian canvas. Each message is a
// node, each reply hangs off its question, and a branch is just a second child
// of the same node. The context a turn is sent is the chain up to the root —
// which means forking inherits everything above and nothing beside it, with no
// bookkeeping of ours, because the canvas already knows who a node's parent is.
//
// Storage is the vault, in Obsidian's own format. Nothing here talks to a
// server of ours; turns go straight to the provider on the user's key. If this
// plugin disappears tomorrow, the conversations are still readable files.

export default class CymosePlugin extends Plugin {
	settings: CymoseSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.registerView(VIEW_TYPE, (leaf) => new CymoseView(leaf, this));
		this.addSettingTab(new CymoseSettingTab(this.app, this));

		this.addRibbonIcon("git-branch", "Cymose", () => void this.openPanel());

		this.addCommand({
			id: "open-panel",
			name: "Open panel",
			callback: () => void this.openPanel(),
		});
		this.addCommand({
			id: "new-conversation",
			name: "New conversation",
			callback: () => void this.newConversation(),
		});
		this.addCommand({
			id: "conversation-from-note",
			name: "Start a conversation about this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.conversationFromNote(file);
				return true;
			},
		});
	}

	onunload(): void {
		// Leaves are Obsidian's to clean up; nothing of ours outlives the app.
	}

	adapter(): ModelAdapter {
		// Rebuilt per call rather than cached: the key can change in settings
		// between turns, and a cached adapter would keep using the old one.
		return new OpenRouterAdapter(this.settings.apiKey);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openPanel(): Promise<CymoseView | null> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return existing[0].view as CymoseView;
		}
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (!leaf) return null;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf.view as CymoseView;
	}

	/** Creates an empty canvas, opens it, and points the panel at it. */
	async newConversation(title = "Conversation"): Promise<TFile | null> {
		try {
			const file = await createCanvas(this.app.vault, this.settings.folder, title);
			await this.app.workspace.getLeaf(true).openFile(file);
			const panel = await this.openPanel();
			await panel?.openFile(file);
			return file;
		} catch (error) {
			new Notice(`Cymose: ${(error as Error).message}`);
			return null;
		}
	}

	/**
	 * Opens a conversation seeded with the current note.
	 *
	 * This is the reason the plugin belongs in Obsidian rather than anywhere
	 * else: the note is already the thinking, and the canvas is where it gets
	 * pushed further. The note is embedded as a `![[wikilink]]` in the first
	 * node, so the conversation stays linked to it in the graph view and keeps
	 * working if the note is later renamed.
	 */
	async conversationFromNote(note: TFile): Promise<void> {
		const file = await this.newConversation(note.basename);
		if (!file) return;
		const data = await readCanvas(this.app.vault, file);
		appendNode(
			data,
			null,
			`About [[${note.basename}]]:\n\n![[${note.basename}]]`,
			COLOR_USER,
		);
		await writeCanvas(this.app.vault, file, data);
		const panel = await this.openPanel();
		await panel?.openFile(file);
	}
}
