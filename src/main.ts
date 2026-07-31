import { FuzzySuggestModal, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CymoseSettingTab, CymoseSettings, DEFAULT_SETTINGS } from "./settings";
import { CymoseAdapter } from "./providers/cymose";
import { OpenRouterAdapter } from "./providers/openrouter";
import type { ModelAdapter } from "./providers/types";
import { CymoseView, VIEW_TYPE } from "./view";
import { appendNode, COLOR_USER, createCanvas, readCanvas, writeCanvas } from "./canvas";
import { fetchTree, mirrorSubtree, roots, subtree, SyncError, type SyncNode } from "./sync";

// Cymose for Obsidian.
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
// Storage is the vault, in Obsidian's own format. If this plugin disappears
// tomorrow, the conversations are still readable files.
//
// Where a turn goes depends on which credential is set: with a Cymose token it
// goes to the Cymose API, which answers it and does not keep it (`ephemeral`);
// with an OpenRouter key it goes straight to OpenRouter on that account. Either
// way the conversation itself lives only in the vault — but "we never see it"
// is not true of the account path and this file should not imply that it is.

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
			id: "pull-from-web",
			name: "Pull a tree from Cymose Web",
			callback: () => void this.pullFromWeb(),
		});
		this.addCommand({
			id: "explore-3-ways",
			name: "Explore 3 ways",
			callback: () => void this.inPanel((view) => view.explore()),
		});
		this.addCommand({
			id: "promote-branch",
			name: "Promote this branch into the node it forked from",
			callback: () => void this.inPanel((view) => view.promote()),
		});
		this.addCommand({
			id: "pin-note",
			name: "Pin a note to the selected node",
			callback: () => void this.inPanel((view) => view.pinNote()),
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

	/**
	 * Which provider answers this turn.
	 *
	 * Cymose first: it is the path that needs nothing but signing in, and its
	 * free tier has the same allowance as the web app. A provider key is the
	 * fallback for people who already have one and would rather spend it —
	 * which also means someone who set a key up before this existed keeps
	 * working exactly as they did, without being signed out or asked anything.
	 *
	 * Rebuilt per call rather than cached: either credential can change in
	 * settings between turns, and a cached adapter would keep the old one.
	 */
	adapter(): ModelAdapter {
		if (this.settings.cymoseToken.trim()) {
			return new CymoseAdapter(this.settings.cymoseApiUrl, this.settings.cymoseToken);
		}
		return new OpenRouterAdapter(this.settings.apiKey);
	}

	/** True when neither path is configured — the one state that can't answer. */
	needsSetup(): boolean {
		return !this.settings.cymoseToken.trim() && !this.settings.apiKey.trim();
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

	/**
	 * Runs a panel action from the command palette.
	 *
	 * These actions need the panel's state — which node you are branching from,
	 * what is in the prompt box — so the command opens the panel and asks it,
	 * rather than keeping a second copy of that state up here that could
	 * disagree with what the user is looking at.
	 */
	private async inPanel(action: (view: CymoseView) => void | Promise<void>): Promise<void> {
		const panel = await this.openPanel();
		if (!panel) {
			new Notice("Cymose: couldn't open the panel.");
			return;
		}
		await action(panel);
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
	 * Mirrors a tree planned on the web onto a canvas here.
	 *
	 * This is the point of the two products being one product. The plan lives
	 * in the browser — you sketch it, branch it three ways, promote what held
	 * up — and then you come to Obsidian to write the thing out properly. Until
	 * now that meant retyping it, which is the copy-paste this whole product
	 * exists to abolish.
	 *
	 * Reading only. Nothing in the vault goes back up, and a mirrored node you
	 * edit here stays here.
	 */
	async pullFromWeb(): Promise<void> {
		const { cymoseApiUrl, cymoseToken } = this.settings;
		if (!cymoseToken.trim()) {
			new Notice("Cymose: add your access token in settings first.");
			return;
		}

		let picks: SyncNode[];
		let tree;
		try {
			new Notice("Cymose: reading your web tree…");
			tree = await fetchTree(cymoseApiUrl, cymoseToken);
			picks = roots(tree);
		} catch (error) {
			// SyncError messages are written to be shown; anything else is a bug
			// and says so rather than pretending to be advice.
			new Notice(
				error instanceof SyncError
					? `Cymose: ${error.message}`
					: `Cymose: pull failed — ${(error as Error).message}`,
			);
			return;
		}

		if (!picks.length) {
			new Notice("Cymose: nothing to pull — there are no chats on the web yet.");
			return;
		}

		new RootPicker(this, picks, async (root) => {
			try {
				const nodes = subtree(tree, root.id);
				const file = await createCanvas(this.app.vault, this.settings.folder, root.title || "Cymose tree");
				const data = await readCanvas(this.app.vault, file);
				const map = (this.settings.syncMap[file.path] ??= {});
				const { added } = mirrorSubtree(data, nodes, map);
				await writeCanvas(this.app.vault, file, data);
				await this.saveSettings();
				await this.app.workspace.getLeaf(true).openFile(file);
				const panel = await this.openPanel();
				await panel?.openFile(file);
				new Notice(`Cymose: pulled ${added} node${added === 1 ? "" : "s"}.`);
			} catch (error) {
				new Notice(`Cymose: ${(error as Error).message}`);
			}
		}).open();
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

/**
 * Which tree to pull.
 *
 * A picker rather than "pull everything": an account can hold dozens of
 * unrelated chats, and dumping all of them into one vault folder is not a
 * feature, it is a mess someone has to clean up by hand.
 */
class RootPicker extends FuzzySuggestModal<SyncNode> {
	constructor(
		plugin: CymosePlugin,
		private roots: SyncNode[],
		private onPick: (root: SyncNode) => void,
	) {
		super(plugin.app);
		this.setPlaceholder("Which tree?");
	}

	getItems(): SyncNode[] {
		return this.roots;
	}

	getItemText(root: SyncNode): string {
		const branches = root.promoted_digest?.trim() ? " · has promoted conclusions" : "";
		return `${root.title || "Untitled"}${branches}`;
	}

	onChooseItem(root: SyncNode): void {
		this.onPick(root);
	}
}
