import { App, FuzzySuggestModal, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
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
	leaves,
	readCanvas,
	removeNode,
	sanitizeCanvasMarkers,
	setPromoted,
	textForModel,
	withModelTag,
	writeCanvas,
} from "./canvas";
import { canvasBridgeWorks, revealNode, selectedNodeId } from "./canvas-api";
import { Message, ProviderError } from "./providers/types";
import { FALLBACK_MODEL_IDS, describe, groupByTier } from "./models";
import { CYMOSE_ICON } from "./main";
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

/**
 * How often a streaming answer is written to its node on the canvas.
 *
 * Not once per chunk — that is a disk write and a canvas re-render several
 * times a second, which is how you make an editor feel broken. Twice a second
 * reads as live and Obsidian never notices.
 */
const CANVAS_FLUSH_MS = 500;

/** What an answer node says before the first words of it arrive. */
const STREAM_PLACEHOLDER = "…";

/** How much of one pinned note is worth sending. Beyond this it is a document,
 *  not context, and it crowds out the conversation it was meant to inform. */
const MAX_NOTE_CHARS = 8000;

/**
 * What a promoted conclusion is asked to be.
 *
 * Short and factual, because it is going to be read as context by every branch
 * opened at that node from now on. A hedged five-paragraph summary inherited
 * twenty times is worse than nothing: it costs tokens on every future turn and
 * tells the model to hedge too.
 */
const PROMOTE_PROMPT =
	"You are compressing one branch of a branching conversation into the conclusion it reached, " +
	"so that branches opened later at the same point inherit it. At most five short lines. State " +
	"what was decided, what was ruled out, and why, as plain facts. Do not restate the question, " +
	"do not hedge, do not add a heading or a preamble.";

/**
 * Where a streaming answer goes while it streams.
 *
 * `push` is called with the whole text so far and drops most of them on the
 * floor; `settle` waits for the last write it actually started, so the final
 * text written after the stream can never be overtaken by a frame from the
 * middle of it.
 */
type StreamSink = { push: (partial: string) => void; settle: () => Promise<void> };

export const VIEW_TYPE = "cymose-panel";

// The panel you talk to. The canvas is the conversation; this is the place you
// choose where to speak from.
//
// What you speak from is whatever you selected on the canvas. That is the one
// gesture this product exists for — see a node, branch from it — and for a long
// time this panel could not do it: Obsidian publishes no canvas selection API,
// so the panel asked you to find the node a second time in a dropdown of every
// node in the conversation. The principle was right about the risk and wrong
// about the price. `canvas-api.ts` now reads the selection, guarded, and when
// it reports nothing the explicit picker below is still here and still works.
export class CymoseView extends ItemView {
	private file: TFile | null = null;
	private data: CanvasData = { nodes: [], edges: [] };
	private parentId: string | null = null;
	// The last canvas selection we adopted. Lets the poll tell a genuine change
	// of mind from the same node merely still being selected — and stops a
	// manual pick being overwritten a moment later by the selection it replaced.
	private lastSeenSelection: string | null = null;
	// Where the shown target came from. Said out loud in the panel: a tool that
	// silently retargets itself is worse than one that makes you point twice.
	private targetFromCanvas = false;
	// Whether reading the canvas selection works on this Obsidian. Re-checked on
	// every reload rather than once at load: the answer depends on which view is
	// in front, and a plugin that decided this at startup would be wrong the
	// first time you opened a canvas.
	private canvasReadable = false;
	private sending = false;
	private streamed = "";
	// The in-flight turn's canceller, and whether the user pressed Stop. `abort`
	// exists only while a stream is open; `stopped` is read by the callers to
	// decide whether to keep the partial and stop rather than carry on.
	private abort: AbortController | null = null;
	private stopped = false;
	// Coalesces calls to MarkdownRenderer.render on the preview element. A
	// render is real async work (post-processors, embeds) — firing one per
	// stream chunk without this would let renders overlap and a later chunk's
	// call finish before an earlier one's, painting stale text back over fresh
	// text. Every caller of flushPreview() gets back the SAME in-flight
	// promise and setting `previewDirty` before returning it guarantees at
	// least one more pass reads the now-current `this.streamed` before the
	// loop can exit — so every await genuinely waits for a render that
	// reflects what was true at the moment of the call, not a stale one.
	private previewRenderPromise: Promise<void> | null = null;
	private previewDirty = false;
	private previewPrefix = "";

	private targetButton!: HTMLButtonElement;
	private targetOrigin!: HTMLElement;
	private modelSelect!: HTMLSelectElement;
	private prompt!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private exploreButton!: HTMLButtonElement;
	private promoteButton!: HTMLButtonElement;
	private pinButton!: HTMLButtonElement;
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
		return CYMOSE_ICON;
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

		// There is no canvas selection event, so the panel looks. Twice a second,
		// only while this view exists (registerInterval ties it to the view's
		// lifetime), and the work is reading a handful of string ids.
		this.registerInterval(
			window.setInterval(() => {
				if (!this.sending) this.syncSelection();
			}, 500),
		);

		// Fetch catalogue silently. If updated, repopulate the dropdown.
		void this.plugin.refreshCatalogue().then((updated) => {
			if (updated) this.populateModels();
		});
	}

	private build(): void {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cymose-panel");

		this.status = root.createDiv({ cls: "cymose-status" });

		// The one thing every turn genuinely needs decided up front: which node
		// it hangs off. A readout of what you already pointed at, not a control
		// you operate — the pointing happened on the canvas. It stays a full
		// labeled row because it is a structural decision in a branching tool,
		// and it stays clickable in both directions: the node name reveals that
		// node on the canvas, "Change" picks a different one without leaving
		// the keyboard.
		const targetRow = root.createDiv({ cls: "cymose-field cymose-target" });
		const targetHead = targetRow.createDiv({ cls: "cymose-target-head" });
		targetHead.createEl("label", { text: "Branch from" });
		this.targetOrigin = targetHead.createSpan({ cls: "cymose-target-origin" });

		const targetControls = targetRow.createDiv({ cls: "cymose-target-controls" });
		this.targetButton = targetControls.createEl("button", { cls: "cymose-target-node" });
		this.targetButton.title = "Show this node on the canvas";
		this.targetButton.onclick = () => this.revealTarget();

		const changeButton = targetControls.createEl("button", {
			cls: "cymose-ghost-btn cymose-target-change",
			text: "Change",
		});
		changeButton.title = "Point at a different node without hunting for it on the canvas";
		changeButton.onclick = () => this.pickTarget();

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

		// The compose bar: model choice and Send/Stop, right where the turn is
		// actually sent from — a property of THIS message, not a setting to dig
		// for above the box. Compact, unlabeled select (title/aria-label carry
		// the meaning) rather than its own full row: picking a model per turn is
		// the thing a branching tool is for, but it shouldn't outweigh the box
		// you're about to type into.
		const composeBar = root.createDiv({ cls: "cymose-compose-bar" });
		this.modelSelect = composeBar.createEl("select", { cls: "dropdown cymose-model-select" });
		this.modelSelect.title = "Model for this turn";
		this.modelSelect.setAttr("aria-label", "Model for this turn");
		this.modelSelect.onchange = () => void this.chooseModel(this.modelSelect.value);
		this.populateModels();

		const composeActions = composeBar.createDiv({ cls: "cymose-compose-actions" });
		this.sendButton = composeActions.createEl("button", { cls: "mod-cta", text: "Send" });
		this.sendButton.onclick = () => void this.send();

		// Cancels the open stream. Hidden until a turn is running, so the row
		// isn't cluttered with a button that does nothing most of the time.
		this.stopButton = composeActions.createEl("button", { cls: "mod-warning", text: "Stop" });
		this.stopButton.title = "Stop the answer. What already streamed is kept.";
		this.stopButton.onclick = () => this.abort?.abort();
		this.stopButton.hide();

		// Real actions, but not things you do every turn — a visual step below
		// the compose bar (smaller, muted, behind a hairline divider) so the
		// panel has one obvious next move instead of six equally-weighted
		// buttons competing for the same glance.
		const secondary = root.createDiv({ cls: "cymose-secondary-actions" });
		this.exploreButton = secondary.createEl("button", { cls: "cymose-ghost-btn", text: "Explore 3 ways" });
		this.exploreButton.title = "Ask this once per strategy — three branches off the same question.";
		this.exploreButton.onclick = () => void this.explore();

		this.promoteButton = secondary.createEl("button", { cls: "cymose-ghost-btn", text: "Promote" });
		this.promoteButton.title = "Summarise this branch into the node it forked from, so later branches inherit it.";
		this.promoteButton.onclick = () => void this.promote();

		this.pinButton = secondary.createEl("button", { cls: "cymose-ghost-btn", text: "Pin a note" });
		this.pinButton.title = "Embed a note in this node. Every branch below it reads the note.";
		this.pinButton.onclick = () => void this.pinNote();

		const newButton = secondary.createEl("button", { cls: "cymose-ghost-btn", text: "New conversation" });
		newButton.onclick = () => void this.plugin.newConversation();

		// markdown-rendered: Obsidian's own class for rendered-markdown typography
		// (headings, code fences, lists, checkboxes) — the same styling every
		// note's reading view gets, so a streamed answer looks native rather than
		// like a plugin's homemade text box.
		this.preview = root.createDiv({ cls: "cymose-preview markdown-rendered" });
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
			if (sanitizeCanvasMarkers(this.data)) {
				await writeCanvas(this.app.vault, this.file, this.data);
			}
		} catch (error) {
			this.setStatus((error as Error).message);
			return;
		}
		this.canvasReadable = canvasBridgeWorks(this.app);
		this.ensureTarget();
		this.syncSelection();
		// A catalogue fetched by the settings tab after this panel was built only
		// reaches the picker on a reload — cheap to rebuild, and it keeps the
		// shown model in step with settings if it was changed there.
		this.populateModels();
		this.setStatus(`${this.file.basename} · ${this.data.nodes.length} node${this.data.nodes.length === 1 ? "" : "s"}`);
	}

	/**
	 * Adopts the canvas selection, if it changed since we last looked.
	 *
	 * Polled rather than subscribed, because there is no selection event to
	 * subscribe to. It is a set of string ids read a few times a second while
	 * the panel is open — cheap enough to be beneath notice, and the only way
	 * to make clicking a node mean something.
	 *
	 * Deselecting is not an instruction. Clicking empty canvas clears the
	 * selection constantly and never means "forget what I was answering"; so a
	 * selection that goes away leaves the target where it was.
	 */
	private syncSelection(): void {
		const selected = selectedNodeId(this.app);
		if (!selected || selected === this.lastSeenSelection) return;
		this.lastSeenSelection = selected;
		// A node from a canvas we aren't attached to isn't ours to branch from.
		if (!this.data.nodes.some((n) => n.id === selected)) return;
		this.parentId = selected;
		this.targetFromCanvas = true;
		this.renderTarget();
	}

	/**
	 * Points the panel at `id`, from an explicit act rather than the canvas.
	 *
	 * Records it as seen, so the poll doesn't hand the target straight back to
	 * whatever is still highlighted on the canvas.
	 */
	setTarget(id: string | null, fromCanvas = false): void {
		this.parentId = id;
		this.targetFromCanvas = fromCanvas;
		if (id) this.lastSeenSelection = id;
		this.renderTarget();
	}

	/**
	 * Chooses the target when nothing on the canvas says what it is.
	 *
	 * Leaves come first: continuing the conversation is what you want nine times
	 * out of ten, and branching from the middle is the deliberate act. This is
	 * the same list the old dropdown held, but fuzzy-searchable — which is the
	 * difference between usable and unusable once a conversation has forty
	 * nodes in it.
	 */
	private ensureTarget(): void {
		if (this.data.nodes.length === 0) {
			this.parentId = null;
			this.targetFromCanvas = false;
			this.renderTarget();
			return;
		}
		if (this.parentId && this.data.nodes.some((n) => n.id === this.parentId)) {
			this.renderTarget();
			return;
		}
		const ends = leaves(this.data);
		this.parentId = ends[ends.length - 1]?.id ?? null;
		this.targetFromCanvas = false;
		this.renderTarget();
	}

	/** The target, as the panel says it. */
	private renderTarget(): void {
		const node = this.parentId ? this.data.nodes.find((n) => n.id === this.parentId) : null;
		if (!node) {
			this.targetButton.setText(this.data.nodes.length ? "— new root —" : "Start of the conversation");
			this.targetButton.removeClass("cymose-target-node--set");
			this.targetOrigin.setText("");
			return;
		}
		const isLeaf = !this.data.edges.some((e) => e.fromNode === node.id);
		this.targetButton.setText(`${isLeaf ? "→" : "⑂"} ${label(node, 48)}`);
		this.targetButton.addClass("cymose-target-node--set");
		// Says which way the target got here, so "why is it answering that node"
		// is never a question you have to reverse-engineer.
		if (this.targetFromCanvas) {
			this.targetOrigin.setText("selected on canvas");
		} else if (!this.canvasReadable) {
			// The guarded bridge found nothing it recognised. Say so once, here,
			// instead of leaving people clicking nodes and wondering why the
			// panel ignores them.
			this.targetOrigin.setText("pick it here — this Obsidian won't tell us what's selected");
		} else {
			this.targetOrigin.setText(isLeaf ? "end of the conversation" : "picked");
		}
	}

	/** Puts the cursor where the next thing you type goes. Called by the canvas
	 *  menu, which has just answered "from where" and left only "what". */
	focusPrompt(): void {
		this.prompt.focus();
	}

	/** Selects the target node on the canvas and brings it into view. */
	private revealTarget(): void {
		if (!this.parentId) {
			this.pickTarget();
			return;
		}
		if (!revealNode(this.app, this.parentId)) {
			new Notice("Cymose: couldn't reach the canvas — open it in the main pane.");
		}
	}

	/** The picker: every node, fuzzy-matched, plus starting a new root. */
	private pickTarget(): void {
		if (!this.data.nodes.length) {
			new Notice("Cymose: this conversation is empty — just type and send.");
			return;
		}
		const ends = leaves(this.data);
		const endIds = new Set(ends.map((n) => n.id));
		const choices: TargetChoice[] = [
			...ends.map((node) => ({ id: node.id, text: `→ ${label(node, 80)}` })),
			...this.data.nodes
				.filter((n) => !endIds.has(n.id))
				.map((node) => ({ id: node.id, text: `⑂ ${label(node, 80)}` })),
			{ id: null, text: "— new root —" },
		];
		new TargetPicker(this.app, choices, (choice) => {
			this.setTarget(choice.id);
			if (choice.id) revealNode(this.app, choice.id);
		}).open();
	}

	/**
	 * Fills the panel's model picker from the cached catalogue.
	 *
	 * Same source as the settings tab: the tiered catalogue from GET /v1/models
	 * when a Cymose account is what pays for the turn, the bare fallback ids when
	 * an OpenRouter key does (our credit tiers describe a bill OpenRouter isn't
	 * sending). The currently-selected model is always kept selectable, even if
	 * it's a free-text id or a hosted model an own-key list hides — the panel
	 * must never show a different model than the turn will actually use.
	 */
	private populateModels(): void {
		const { model, modelCatalogue, cymoseToken, apiKey } = this.plugin.settings;
		const usingOwnKey = !cymoseToken.trim() && Boolean(apiKey.trim());
		const catalogue = usingOwnKey ? [] : modelCatalogue;
		this.modelSelect.empty();

		const known = new Set<string>();
		if (catalogue.length) {
			// Obsidian's dropdown has no group API, so the optgroups go on the
			// select directly — the same approach the settings tab takes.
			for (const group of groupByTier(catalogue)) {
				const optgroup = this.modelSelect.createEl("optgroup");
				optgroup.label = group.label;
				for (const entry of group.models) {
					optgroup.createEl("option", { value: entry.id, text: describe(entry) });
					known.add(entry.id);
				}
			}
		} else {
			for (const id of FALLBACK_MODEL_IDS) {
				this.modelSelect.createEl("option", { value: id, text: id });
				known.add(id);
			}
		}
		if (model && !known.has(model)) {
			this.modelSelect.createEl("option", { value: model, text: model });
		}
		this.modelSelect.value = model;
	}

	private async chooseModel(id: string): Promise<void> {
		if (!id) return;
		this.plugin.settings.model = id;
		await this.plugin.saveSettings();
	}

	/** How the answering model reads on a node: the catalogue's friendly name
	 *  when we have it, the raw id otherwise. */
	private modelLabel(id: string): string {
		return this.plugin.settings.modelCatalogue.find((m) => m.id === id)?.label ?? id;
	}

	private setStatus(text: string): void {
		this.status.setText(text);
	}

	/** Everything that writes or spends runs one at a time, and the panel says so. */
	private begin(busyLabel: string): void {
		this.sending = true;
		this.stopped = false;
		this.sendButton.setText(busyLabel);
		for (const button of [this.sendButton, this.exploreButton, this.promoteButton, this.pinButton]) {
			button.disabled = true;
		}
		this.stopButton.disabled = false;
		this.stopButton.show();
	}

	private end(): void {
		this.sending = false;
		this.sendButton.setText("Send");
		for (const button of [this.sendButton, this.exploreButton, this.promoteButton, this.pinButton]) {
			button.disabled = false;
		}
		this.stopButton.hide();
	}

	/** A canvas to write to and a way to pay for the turn, or a reason why not. */
	private async ready(): Promise<boolean> {
		if (this.sending) return false;
		if (!this.file) {
			await this.plugin.newConversation();
			if (!this.file) return false;
		}
		if (this.plugin.needsSetup()) {
			// Names the path we want people on, and doesn't hide the other one.
			new Notice("Cymose: sign in to Cymose in settings — or add your own OpenRouter key.");
			return false;
		}
		return true;
	}

	private fail(error: unknown): void {
		const message = error instanceof ProviderError ? error.friendly : (error as Error).message;
		new Notice(`Cymose: ${message}`, 8000);
		this.setStatus(message);
	}

	/**
	 * Renders the live preview as actual markdown, not raw text.
	 *
	 * Obsidian is a markdown-native app — asterisks and backticks sitting
	 * literally on screen while an answer streams reads as unfinished, and
	 * disagrees with how the same text looks a moment later once it's written
	 * into the canvas node (which Obsidian renders normally). Always reads
	 * `this.streamed` live rather than taking the text as a parameter, so the
	 * dirty-flag redraw below can never paint something stale.
	 */
	private flushPreview(): Promise<void> {
		this.previewDirty = true;
		if (!this.previewRenderPromise) {
			this.previewRenderPromise = this.runPreviewRenderLoop();
		}
		return this.previewRenderPromise;
	}

	private async runPreviewRenderLoop(): Promise<void> {
		while (this.previewDirty) {
			this.previewDirty = false;
			const text = this.previewPrefix + stripServerMarkers(this.streamed);
			this.preview.empty();
			await MarkdownRenderer.render(this.app, text, this.preview, "", this);
			this.preview.scrollTop = this.preview.scrollHeight;
			// If flushPreview() was called again while the render above was in
			// flight, previewDirty is true again here — loop once more, reading
			// `this.streamed` fresh rather than returning already a chunk behind.
		}
		this.previewRenderPromise = null;
	}

	/**
	 * Applies a change to the canvas file, re-reading it first.
	 *
	 * The re-read is what lets a turn run for thirty seconds without eating an
	 * edit someone made elsewhere on the board in the meantime: we write back a
	 * file we just looked at, with one node changed, rather than the copy the
	 * panel happened to be holding.
	 */
	private async patchCanvas(file: TFile, change: (data: CanvasData) => void): Promise<void> {
		const data = await readCanvas(this.app.vault, file);
		change(data);
		await writeCanvas(this.app.vault, file, data);
	}

	/** Sets one node's text and re-fits its height to it. */
	private async writeNodeText(file: TFile, nodeId: string, text: string): Promise<void> {
		await this.patchCanvas(file, (data) => {
			const node = data.nodes.find((n) => n.id === nodeId);
			if (!node) return;
			node.text = text;
			node.height = estimateHeight(text);
		});
	}

	/**
	 * A sink that writes the answer into its node on the canvas as it arrives.
	 *
	 * This is the change that makes the canvas the place the conversation
	 * happens rather than the place it is filed afterwards. It used to stream
	 * into a box in the sidebar and land as a node somewhere on the board when
	 * it was over — one thing in two places, and you had to go and find it.
	 *
	 * A dropped intermediate frame costs nothing: the final text is written
	 * unconditionally when the stream ends, so a failed write here is worth
	 * swallowing rather than interrupting an answer over.
	 */
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

	/**
	 * Streams one answer, into its node on the canvas and into the panel's
	 * preview at the same time, and hands the finished text back.
	 *
	 * The preview is the reading copy — wide markdown, scrollable, and it does
	 * not move under you the way a growing canvas node does. The node is where
	 * the answer actually lives. Both show the same text at the same time,
	 * which is the point: nothing lands anywhere you weren't watching.
	 */
	private async streamTurn(
		messages: Message[],
		heading: string,
		model: string,
		sink?: StreamSink,
	): Promise<string> {
		this.previewPrefix = heading ? `${heading}\n\n` : "";
		this.streamed = "";
		await this.flushPreview();
		const controller = new AbortController();
		this.abort = controller;
		try {
			for await (const chunk of this.plugin.adapter().chat(messages, {
				model,
				temperature: this.plugin.settings.temperature,
				maxTokens: this.plugin.settings.maxTokens,
			}, controller.signal)) {
				this.streamed += chunk;
				// Fire-and-forget: flushPreview's own in-flight guard coalesces any
				// chunks that arrive faster than markdown rendering keeps up with,
				// so this never queues unbounded work or races itself.
				void this.flushPreview();
				sink?.push(this.streamed);
			}
		} catch (error) {
			// Stop pressed: keep what streamed and let the caller write it, rather
			// than throwing away a half-written answer the user chose to cut short.
			// Any other error is a real failure and propagates.
			if (error instanceof DOMException && error.name === "AbortError") {
				this.stopped = true;
			} else {
				throw error;
			}
		} finally {
			this.abort = null;
		}
		// Settle on the final, complete text — a fire-and-forget flush from the
		// last chunk may still be catching up, in the preview and on the canvas
		// both. Waiting for the canvas one is what stops a frame from the middle
		// of the stream landing on top of the final text the caller writes next.
		await this.flushPreview();
		await sink?.settle();
		return stripServerMarkers(this.streamed).trim();
	}

	/** One turn: write the question, open the answer node, stream into it. */
	private async send(): Promise<void> {
		const text = this.prompt.value.trim();
		if (!text) return;
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		// Fixed for the whole turn, so the caption names the model that actually
		// answered even if the picker is changed while the answer streams.
		const usedModel = this.plugin.settings.model;
		// Declared out here so the catch below knows whether there is a
		// half-written node on the canvas to salvage or take back.
		let answerId: string | null = null;
		this.begin("Sending…");
		try {
			// Re-read before writing: the file may have changed since the panel
			// last looked, and appending to a stale copy would drop those nodes.
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			// The answer node exists before a word of it does. The board used to
			// sit still for as long as the model took and then grow a node
			// somewhere you had to go and find; now the place the answer will
			// live is visible from the moment you press Send, and fills up in
			// front of you.
			const answerNode = appendNode(this.data, question.id, STREAM_PLACEHOLDER, COLOR_ASSISTANT);
			answerId = answerNode.id;
			await writeCanvas(this.app.vault, file, this.data);
			revealNode(this.app, answerNode.id);

			// Built from the question, so the empty answer node just created is not
			// in the chain — ancestry walks upwards.
			const messages = await this.buildMessages(question.id);
			const streamed = await this.streamTurn(messages, "", usedModel, this.canvasSink(file, answerNode.id));

			if (this.stopped && !streamed) {
				// Cut short before a word arrived: the question stays, but the
				// placeholder is ours and an empty node is litter, so we take it
				// back rather than leave it to be deleted by hand.
				await this.patchCanvas(file, (data) => removeNode(data, answerNode.id));
				new Notice("Cymose: stopped. Your question is on the canvas.");
				await this.reload();
				this.setTarget(question.id);
				return;
			}
			// Tag real answers with the model; leave the "nothing came back"
			// placeholder untagged — there's no answer to attribute.
			const answer = streamed
				? withModelTag(streamed, this.modelLabel(usedModel))
				: "_(the model returned nothing)_";
			await this.writeNodeText(file, answerNode.id, answer);
			if (this.stopped) new Notice("Cymose: stopped — kept the partial answer.");

			this.prompt.value = "";
			await this.reload();
			// Continue from the answer, which is where the next question goes —
			// and select it on the canvas, so the panel and the board agree about
			// where you are without you having to go and find the new node.
			this.setTarget(answerNode.id);
			revealNode(this.app, answerNode.id);
		} catch (error) {
			// The question node stays. It cost nothing, it records what was asked,
			// and deleting it would also delete whatever the user typed. The
			// answer node only stays if there is an answer in it.
			this.fail(error);
			if (answerId) await this.salvage(file, answerId, usedModel);
			await this.reload();
		} finally {
			this.end();
		}
	}

	/**
	 * What to do with an answer node whose turn died mid-flight.
	 *
	 * Whatever streamed before the failure is kept — it is often the useful
	 * half, and it is the part the user watched arrive, so deleting it would be
	 * taking away something they had already read. Nothing streamed means the
	 * node is a placeholder we put there and nobody wants, so it goes.
	 */
	private async salvage(file: TFile, nodeId: string, model: string): Promise<void> {
		const partial = stripServerMarkers(this.streamed).trim();
		try {
			if (partial) {
				await this.writeNodeText(file, nodeId, withModelTag(partial, this.modelLabel(model)));
			} else {
				await this.patchCanvas(file, (data) => removeNode(data, nodeId));
			}
		} catch {
			// Already failing. A second error here would replace a useful message
			// about why the turn died with a useless one about tidying up.
		}
	}

	/**
	 * The same question, three ways, as three branches off one node.
	 *
	 * This is the thing a canvas is for and a chat box cannot do. Three answers
	 * side by side, none of them contaminated by the other two, and all three
	 * still there tomorrow when you want to know why you picked the one you
	 * picked.
	 */
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
		this.begin("Exploring…");
		try {
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			await writeCanvas(this.app.vault, file, this.data);

			const base = await this.buildMessages(question.id);
			let written = 0;

			for (const [index, strategy] of STRATEGIES.entries()) {
				// Each branch is drawn before it is answered, so the fork appears
				// on the canvas as it is being explored. This is the fix that
				// matters most here: all three answers used to stream through the
				// one preview box in turn, each wiping out the last, so the
				// comparison this feature exists for was impossible to watch and
				// only assembled itself once everything had finished.
				const caption = `_${strategy.label}_\n\n`;
				this.data = await readCanvas(this.app.vault, file);
				const branch = appendNode(this.data, question.id, caption + STREAM_PLACEHOLDER, COLOR_ASSISTANT);
				await writeCanvas(this.app.vault, file, this.data);
				revealNode(this.app, branch.id);

				let answer: string;
				try {
					answer = await this.streamTurn(
						this.withNudge(base, strategy.nudge),
						`${index + 1}/${STRATEGIES.length} · ${strategy.label}`,
						usedModel,
						this.canvasSink(file, branch.id, caption),
					);
				} catch (error) {
					// One strategy failing is no reason to throw away the ones that
					// worked. A rate limit halfway through costs you a branch, not
					// the exploration.
					this.fail(error);
					await this.salvage(file, branch.id, usedModel);
					break;
				}
				if (answer) {
					await this.writeNodeText(file, branch.id, withModelTag(caption + answer, this.modelLabel(usedModel)));
					written += 1;
				} else {
					// Nothing came back for this strategy: take the placeholder back
					// rather than leave an empty branch that looks like an answer.
					await this.patchCanvas(file, (data) => removeNode(data, branch.id));
				}
				// Stop ends the whole exploration, not just this strategy — the
				// branches already written stay, the ones not yet asked don't run.
				if (this.stopped) break;
			}

			this.prompt.value = "";
			await this.reload();
			// Stay on the question: the next thing you do is compare the three,
			// and anything you ask next belongs beside them, not under whichever
			// one happened to finish last.
			this.setTarget(question.id);
			revealNode(this.app, question.id);
			if (written) {
				new Notice(`Cymose: ${written} branch${written === 1 ? "" : "es"} off that question.`);
			}
		} catch (error) {
			this.fail(error);
		} finally {
			this.end();
		}
	}

	/**
	 * Sends this branch's conclusion back up to the node it forked from.
	 *
	 * The half of branching nobody else does. Forking is easy and every canvas
	 * has it; the problem is that a decision made three levels down stays down
	 * there, and the next branch you open re-litigates it. Promote compresses the
	 * branch into what it settled and writes that into the fork point — so every
	 * branch opened there afterwards starts already knowing.
	 */
	async promote(): Promise<void> {
		const tipId = this.parentId;
		if (!tipId) {
			new Notice("Cymose: select the tip of the branch you want promoted.");
			return;
		}
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		this.begin("Promoting…");
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

			// Labels taken before the write: after it, the target's text carries the
			// conclusion we just added and would make a nonsense label.
			const targetLabel = label(target, 40);
			const tipLabel = label(tip, 40);

			const digest = await this.streamTurn(
				[
					{ role: "system", content: PROMOTE_PROMPT },
					{ role: "user", content: transcript },
				],
				`promoting into “${targetLabel}”`,
				this.plugin.settings.model,
			);
			// A half-written conclusion is worse than none — it's inherited by every
			// later branch. If Stop cut it short, promote nothing.
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

	/**
	 * Pins a note to the selected node. Every branch below it reads the note.
	 *
	 * The reason this plugin belongs in Obsidian rather than in a browser tab:
	 * the reference material is already here, already written by you, and pinning
	 * it costs a click instead of a paste. It goes in as an ordinary embed, so
	 * the canvas shows the note inline and the vault's graph knows about the
	 * link — and because it is resolved at send time, editing the note changes
	 * what every branch below it is answered against.
	 */
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

	/**
	 * Merged into the system message rather than appended as a second one:
	 * providers disagree about whether a system turn may appear after user turns,
	 * and an exploration is not the place to find out which one you are on.
	 */
	private withNudge(base: Message[], nudge: string): Message[] {
		const messages = base.slice();
		if (messages[0]?.role === "system") {
			messages[0] = { role: "system", content: `${messages[0].content}\n\n${nudge}` };
		} else {
			messages.unshift({ role: "system", content: nudge });
		}
		return messages;
	}

	/**
	 * The branch, as messages.
	 *
	 * The chain up to the root is the context — which is what makes a branch a
	 * branch rather than a fresh chat: fork from any node and the new line
	 * inherits everything above it and nothing beside it. Sibling branches stay
	 * invisible to each other, which is the point. Promoted conclusions ride
	 * along for free, because they live in the text of a node on this chain.
	 *
	 * Roles alternate by colour, because that is what we set when we wrote the
	 * node; a hand-added node has no colour and is treated as the user's, which
	 * is the reading that makes "type a note on the canvas and ask about it"
	 * work.
	 */
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

	/**
	 * Replaces `![[note]]` with what the note actually says.
	 *
	 * Without this a pinned note is decoration: the canvas shows the note
	 * embedded, the request carries a filename in double brackets, and the answer
	 * comes back as though nothing were pinned at all. Resolved at send time
	 * rather than at pin time, so editing the note changes every branch below it
	 * without re-pinning anything.
	 */
	private async resolveEmbeds(text: string): Promise<string> {
		const embeds = [...text.matchAll(/!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)];
		if (!embeds.length) return text;

		let out = text;
		for (const match of embeds) {
			const target = this.app.metadataCache.getFirstLinkpathDest(
				match[1].trim(),
				this.file?.path ?? "",
			);
			// Not something we can read as text — an image, or a link to a note
			// that doesn't exist. Leave the embed as written rather than silently
			// dropping what the user pinned.
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
			// Function replacement, not a string: a note containing `$&` or `$1`
			// would otherwise be spliced into itself by the regex engine.
			out = out.replace(
				match[0],
				() => `--- note: ${target.basename} ---\n${clipped.trim()}\n--- end of note ---`,
			);
		}
		return out;
	}
}

/** One entry in the target picker. A null id means "start a new root". */
type TargetChoice = { id: string | null; text: string };

/**
 * Which node to branch from, when the canvas isn't answering that.
 *
 * A modal rather than the dropdown this replaced, for one reason: it is
 * fuzzy-searchable. The dropdown listed every node in the conversation with no
 * way to find one, which was fine at ten nodes and useless at forty — and forty
 * nodes is what a tool built for branching produces in an afternoon.
 */
class TargetPicker extends FuzzySuggestModal<TargetChoice> {
	constructor(
		app: App,
		private choices: TargetChoice[],
		private onPick: (choice: TargetChoice) => void,
	) {
		super(app);
		this.setPlaceholder("Branch from which node?");
	}

	getItems(): TargetChoice[] {
		return this.choices;
	}

	getItemText(choice: TargetChoice): string {
		return choice.text;
	}

	onChooseItem(choice: TargetChoice): void {
		this.onPick(choice);
	}
}

/** Which note to pin. Every markdown file in the vault, fuzzy-matched by path. */
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
