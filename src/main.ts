import {
	addIcon,
	App,
	EventRef,
	Menu,
	normalizePath,
	Notice,
	Plugin,
	requestUrl,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { CymoseSettingTab, CymoseSettings, DEFAULT_SETTINGS, parseSettings } from "./settings";
import { createAdapter } from "./providers/create";
import type { ModelAdapter } from "./providers/types";
import { CymoseOverlay, canvasFileOf } from "./view";
import { appendNode, COLOR_USER, createCanvas, readCanvas, writeCanvas } from "./canvas";
import { isCymoseHostedModel } from "./models";

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
// A turn goes to the provider in settings, on the user's key. Cymose is not
// in that path. The conversation itself lives only in the vault.

/**
 * Bring a leaf into view, on every Obsidian this plugin claims to support.
 *
 * `revealLeaf` returned void for years and returns a Promise in recent
 * versions. Awaiting it is what the community reviewer flags as
 * `no-unsupported-api`: the await only makes sense on an API newer than the
 * declared minAppVersion of 1.5.0, so on 1.5.0 the plugin would be calling
 * something that is not there in the shape it expects.
 *
 * Calling and not awaiting is correct on both. There is nothing after it that
 * depends on the reveal having finished — the leaf is returned either way, and
 * the panel renders when Obsidian gets to it.
 */
function revealLeaf(app: App, leaf: WorkspaceLeaf): void {
	void (app.workspace.revealLeaf(leaf) as unknown as void | Promise<void>);
}

// The Cymose mark (shared/brand/mark-cyme.svg): an upside-down Y — a stem into a
// filled node, two arms splaying into open ones. Registered as an Obsidian icon
// so the ribbon button carries the logo instead of a generic lucide glyph.
// addIcon wraps this in <svg viewBox="0 0 100 100">, so the artwork
// (drawn on a 64 grid) is scaled up by 100/64 = 1.5625 and stroked in
// currentColor, which makes it follow the theme like every built-in icon does.
export const CYMOSE_ICON = "cymose-mark";
const CYMOSE_ICON_SVG =
	'<g transform="scale(1.5625)" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round">' +
	'<path d="M32 7 L32 21"/>' +
	'<path d="M28.4 31.8 L18.4 45.2"/>' +
	'<path d="M35.6 31.8 L45.6 45.2"/>' +
	'<circle cx="32" cy="27" r="6" fill="currentColor" stroke="none"/>' +
	'<circle cx="14" cy="51" r="5"/>' +
	'<circle cx="50" cy="51" r="5"/>' +
	"</g>";

export default class CymosePlugin extends Plugin {
	settings: CymoseSettings = DEFAULT_SETTINGS;
	private overlays = new WeakMap<WorkspaceLeaf, CymoseOverlay>();
	private overlayLeaves = new Set<WorkspaceLeaf>();

	async onload(): Promise<void> {
		this.settings = parseSettings(await this.loadData());
		if (isCymoseHostedModel(this.settings.model)) {
			this.settings.model = DEFAULT_SETTINGS.model;
			await this.saveSettings();
		}

		addIcon(CYMOSE_ICON, CYMOSE_ICON_SVG);

		this.addSettingTab(new CymoseSettingTab(this.app, this));

		this.addRibbonIcon(CYMOSE_ICON, "Cymose", () => void this.openCymose());

		this.addCommand({
			id: "open-cymose",
			name: "Open conversation",
			callback: () => void this.openCymose(),
		});
		this.addCommand({
			id: "new-conversation",
			name: "New conversation",
			callback: () => void this.newConversation(),
		});
		this.addCommand({
			id: "explore-3-ways",
			name: "Explore 3 ways",
			callback: () => void this.withOverlay((overlay) => overlay.explore()),
		});
		this.addCommand({
			id: "promote-branch",
			name: "Promote this branch into the node it forked from",
			callback: () => void this.withOverlay((overlay) => overlay.promote()),
		});
		this.addCommand({
			id: "pin-note",
			name: "Pin a note to the selected node",
			callback: () => void this.withOverlay((overlay) => overlay.pinNote()),
		});
		this.registerCanvasMenu();

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

		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncOverlays()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncOverlays()));
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.detachLeavesOfType("cymose-panel");
			this.syncOverlays();
		});
	}

	onunload(): void {
		for (const leaf of this.overlayLeaves) {
			this.overlays.get(leaf)?.detach();
		}
		this.overlayLeaves.clear();
	}

	/** Conversations live in the configured folder. Composer docks only there. */
	isCymoseCanvas(file: TFile): boolean {
		const folder = normalizePath(this.settings.folder || "Cymose");
		const path = normalizePath(file.path);
		return path === folder || path.startsWith(`${folder}/`);
	}

	private syncOverlays(): void {
		const live = new Set<WorkspaceLeaf>();
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const file = canvasFileOf(leaf);
			if (!file || !this.isCymoseCanvas(file)) continue;
			live.add(leaf);
			let overlay = this.overlays.get(leaf);
			if (!overlay) {
				overlay = new CymoseOverlay(this, leaf);
				this.overlays.set(leaf, overlay);
			}
			overlay.bind(file);
		}
		for (const leaf of this.overlayLeaves) {
			if (live.has(leaf)) continue;
			this.overlays.get(leaf)?.detach();
			this.overlays.delete(leaf);
		}
		this.overlayLeaves = live;
	}

	activeOverlay(): CymoseOverlay | null {
		const active = this.app.workspace.activeLeaf;
		if (active) {
			const overlay = this.overlays.get(active);
			if (overlay) return overlay;
		}
		for (const leaf of this.overlayLeaves) {
			const overlay = this.overlays.get(leaf);
			if (overlay) return overlay;
		}
		return null;
	}

	/**
	 * Enter Cymose: a canvas in the main pane, composer on it.
	 *
	 * Reuses an already-open conversation if there is one; otherwise starts a
	 * new canvas. Never a sidebar.
	 */
	async openCymose(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		if (active && this.isCymoseCanvas(active)) {
			this.syncOverlays();
			this.activeOverlay()?.focusPrompt();
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const file = canvasFileOf(leaf);
			if (!file || !this.isCymoseCanvas(file)) continue;
			revealLeaf(this.app, leaf);
			this.syncOverlays();
			this.overlays.get(leaf)?.focusPrompt();
			return;
		}
		await this.newConversation();
	}

	private async withOverlay(action: (overlay: CymoseOverlay) => void | Promise<void>): Promise<void> {
		this.syncOverlays();
		let overlay = this.activeOverlay();
		if (!overlay) {
			await this.openCymose();
			this.syncOverlays();
			overlay = this.activeOverlay();
		}
		if (!overlay) {
			new Notice("Cymose: open a conversation canvas first.");
			return;
		}
		await action(overlay);
	}

	/**
	 * Cymose on the canvas's own right-click menu.
	 *
	 * The idiom Obsidian users already have for "do something to this thing",
	 * and the natural home for every action this plugin has, because all of them
	 * are about one node. Before this, right-clicking a node offered nothing and
	 * the panel asked you to name the node again in a list — the gesture people
	 * try first did nothing, which is the worst answer a UI can give.
	 *
	 * `canvas:node-menu` isn't in the published typings. It is dispatched
	 * through `Events`, whose `on(name: string, …)` overload is public API;
	 * `Workspace` merely shadows it with named ones. So the widening below is a
	 * claim about the event's payload, not a reach into internals — and a
	 * payload that turns out differently costs a menu item, not a crash.
	 */
	private registerCanvasMenu(): void {
		const workspace = this.app.workspace as App["workspace"] & {
			on(
				name: "canvas:node-menu",
				callback: (menu: Menu, node: { id?: unknown }) => void,
			): EventRef;
		};

		this.registerEvent(
			workspace.on("canvas:node-menu", (menu, node) => {
				const id = typeof node?.id === "string" ? node.id : null;
				if (!id) return;

				const act = (action: (overlay: CymoseOverlay) => void | Promise<void>) =>
					void this.withOverlay(async (overlay) => {
						overlay.setTarget(id);
						await action(overlay);
					});

				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("Reply here")
						.setIcon(CYMOSE_ICON)
						.onClick(() => act((view) => view.focusPrompt())),
				);
				menu.addItem((item) =>
					item
						.setTitle("Explore 3 ways from here")
						.setIcon(CYMOSE_ICON)
						.onClick(() => act((view) => view.explore())),
				);
				menu.addItem((item) =>
					item
						.setTitle("Promote this branch")
						.setIcon(CYMOSE_ICON)
						.onClick(() => act((view) => view.promote())),
				);
				menu.addItem((item) =>
					item
						.setTitle("Pin a note here")
						.setIcon(CYMOSE_ICON)
						.onClick(() => act((view) => view.pinNote())),
				);
			}),
		);
	}

	/**
	 * Who answers this turn.
	 *
	 * The key in this vault, the provider in settings. Cymose is not a chat
	 * provider. Rebuilt per call: the key can change between turns.
	 */
	adapter(): ModelAdapter {
		return createAdapter(this.settings);
	}

	needsSetup(): boolean {
		if (this.settings.provider === "custom") return !this.settings.baseUrl.trim();
		return !this.settings.apiKey.trim();
	}

	async testProvider(): Promise<{ ok: boolean; message: string }> {
		const { provider, apiKey, baseUrl } = this.settings;
		if (provider !== "custom" && !apiKey.trim()) {
			return { ok: false, message: "No key yet." };
		}
		if (provider === "custom" && !baseUrl.trim()) {
			return { ok: false, message: "No base URL yet." };
		}

		const url =
			provider === "openai"
				? "https://api.openai.com/v1/models"
				: provider === "anthropic"
					? "https://api.anthropic.com/v1/models"
					: provider === "google"
						? "https://generativelanguage.googleapis.com/v1beta/openai/models"
						: provider === "custom"
							? `${baseUrl.trim().replace(/\/+$/, "")}/models`
							: "https://openrouter.ai/api/v1/key";

		const headers: Record<string, string> = {};
		if (apiKey.trim()) {
			if (provider === "anthropic") {
				headers["x-api-key"] = apiKey.trim();
				headers["anthropic-version"] = "2023-06-01";
			} else {
				headers.Authorization = `Bearer ${apiKey.trim()}`;
			}
		}

		let response;
		try {
			response = await requestUrl({ url, method: "GET", headers, throw: false });
		} catch (error) {
			return { ok: false, message: `Couldn't reach the provider — ${(error as Error).message}` };
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, message: "The provider rejected that key." };
		}
		if (response.status >= 400) {
			return { ok: false, message: `Provider answered ${response.status}.` };
		}
		return { ok: true, message: "Connected. Type any model id in the composer." };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async openCanvasFile(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		this.syncOverlays();
		this.overlays.get(leaf)?.focusPrompt();
	}

	/** Creates an empty canvas and opens it in the main pane. */
	async newConversation(title = "Conversation"): Promise<TFile | null> {
		try {
			const file = await createCanvas(this.app.vault, this.settings.folder, title);
			await this.openCanvasFile(file);
			return file;
		} catch (error) {
			new Notice(`Cymose: ${(error as Error).message}`);
			return null;
		}
	}

	/**
	 * Opens a conversation seeded with the current note.
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
		this.syncOverlays();
	}
}
