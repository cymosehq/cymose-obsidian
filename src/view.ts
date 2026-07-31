import { App, FuzzySuggestModal, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
	CanvasData,
	CanvasNode,
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
	setPromoted,
	textForModel,
	writeCanvas,
} from "./canvas";
import { Message, ProviderError } from "./providers/types";
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

		this.exploreButton = actions.createEl("button", { text: "Explore 3 ways" });
		this.exploreButton.title = "Ask this once per strategy — three branches off the same question.";
		this.exploreButton.onclick = () => void this.explore();

		const branchActions = root.createDiv({ cls: "cymose-actions" });
		this.promoteButton = branchActions.createEl("button", { text: "Promote" });
		this.promoteButton.title = "Summarise this branch into the node it forked from, so later branches inherit it.";
		this.promoteButton.onclick = () => void this.promote();

		this.pinButton = branchActions.createEl("button", { text: "Pin a note" });
		this.pinButton.title = "Embed a note in this node. Every branch below it reads the note.";
		this.pinButton.onclick = () => void this.pinNote();

		const newButton = branchActions.createEl("button", { text: "New conversation" });
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

	/** Everything that writes or spends runs one at a time, and the panel says so. */
	private begin(busyLabel: string): void {
		this.sending = true;
		this.sendButton.setText(busyLabel);
		for (const button of [this.sendButton, this.exploreButton, this.promoteButton, this.pinButton]) {
			button.disabled = true;
		}
	}

	private end(): void {
		this.sending = false;
		this.sendButton.setText("Send");
		for (const button of [this.sendButton, this.exploreButton, this.promoteButton, this.pinButton]) {
			button.disabled = false;
		}
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
	 * Streams one answer into the panel and hands it back.
	 *
	 * Written to the canvas by the caller, once, at the end. Rewriting the file
	 * on every chunk would mean a disk write and a canvas re-render several times
	 * a second, which is how you make an editor feel broken — and the live text
	 * is right here in the panel while it arrives.
	 */
	private async streamTurn(messages: Message[], heading: string): Promise<string> {
		const prefix = heading ? `${heading}\n\n` : "";
		this.streamed = "";
		this.preview.setText(prefix);
		for await (const chunk of this.plugin.adapter().chat(messages, {
			model: this.plugin.settings.model,
			temperature: this.plugin.settings.temperature,
			maxTokens: this.plugin.settings.maxTokens,
		})) {
			this.streamed += chunk;
			this.preview.setText(prefix + this.streamed);
			this.preview.scrollTop = this.preview.scrollHeight;
		}
		return this.streamed.trim();
	}

	/** One turn: write the question, stream the answer, then write it. */
	private async send(): Promise<void> {
		const text = this.prompt.value.trim();
		if (!text) return;
		if (!(await this.ready())) return;
		const file = this.file;
		if (!file) return;

		this.begin("Sending…");
		try {
			// Re-read before writing: the file may have changed since the panel
			// last looked, and appending to a stale copy would drop those nodes.
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			await writeCanvas(this.app.vault, file, this.data);

			const answer = (await this.streamTurn(await this.buildMessages(question.id), "")) ||
				"_(the model returned nothing)_";

			this.data = await readCanvas(this.app.vault, file);
			const node = appendNode(this.data, question.id, answer, COLOR_ASSISTANT);
			node.height = estimateHeight(answer);
			await writeCanvas(this.app.vault, file, this.data);

			this.prompt.value = "";
			await this.reload();
			// Continue from the answer, which is where the next question goes.
			this.parentId = node.id;
			this.parentSelect.value = node.id;
		} catch (error) {
			// The question node stays. It cost nothing, it records what was asked,
			// and deleting it would also delete whatever the user typed.
			this.fail(error);
		} finally {
			this.end();
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

		this.begin("Exploring…");
		try {
			this.data = await readCanvas(this.app.vault, file);
			const question = appendNode(this.data, this.parentId, text, COLOR_USER);
			await writeCanvas(this.app.vault, file, this.data);

			const base = await this.buildMessages(question.id);
			let written = 0;

			for (const [index, strategy] of STRATEGIES.entries()) {
				let answer: string;
				try {
					answer = await this.streamTurn(
						this.withNudge(base, strategy.nudge),
						`${index + 1}/${STRATEGIES.length} · ${strategy.label}`,
					);
				} catch (error) {
					// One strategy failing is no reason to throw away the ones that
					// worked. A rate limit halfway through costs you a branch, not
					// the exploration.
					this.fail(error);
					break;
				}
				if (!answer) continue;

				this.data = await readCanvas(this.app.vault, file);
				const node = appendNode(
					this.data,
					question.id,
					`_${strategy.label}_\n\n${answer}`,
					COLOR_ASSISTANT,
				);
				node.height = estimateHeight(node.text ?? "");
				await writeCanvas(this.app.vault, file, this.data);
				written += 1;
			}

			this.prompt.value = "";
			await this.reload();
			// Leave the picker on the question: the next thing you do is compare
			// the three, and anything you ask next belongs beside them, not under
			// whichever one happened to finish last.
			this.parentId = question.id;
			this.parentSelect.value = question.id;
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
			new Notice("Cymose: pick the branch to promote in “Branch from”.");
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
			);
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
			new Notice("Cymose: pick the node to pin a note to in “Branch from”.");
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
