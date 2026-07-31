import { normalizePath, TFile, Vault } from "obsidian";

// The conversation is a real Obsidian canvas file.
//
// This is the decision the whole plugin rests on. We could have drawn our own
// board in a custom view — but then the conversation would live inside the
// plugin, and be worth nothing the day you uninstall it. A `.canvas` file is
// Obsidian's own format (JSON Canvas): it pans, zooms, arranges, links to
// notes, survives us, and can be edited by hand. Branching costs nothing to
// build because a canvas is already a graph.
//
// Format: https://jsoncanvas.org

export type CanvasNode = {
	id: string;
	type: "text" | "file" | "link" | "group";
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
	file?: string;
	/** Obsidian's preset colours are "1".."6"; we use 5 (green) and 6 (purple). */
	color?: string;
};

export type CanvasEdge = {
	id: string;
	fromNode: string;
	fromSide: "top" | "right" | "bottom" | "left";
	toNode: string;
	toSide: "top" | "right" | "bottom" | "left";
};

export type CanvasData = { nodes: CanvasNode[]; edges: CanvasEdge[] };

export const NODE_WIDTH = 420;
/** Height of a fresh node. Obsidian doesn't auto-fit, so we estimate from the
 *  text length rather than leaving long answers clipped. */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;
const COLUMN_GAP = 60;
const ROW_GAP = 80;

/** Colours carry the one distinction that matters at a glance. */
export const COLOR_USER = "6";
export const COLOR_ASSISTANT = "5";

export function estimateHeight(text: string): number {
	// ~55 characters per line at this width, ~22px per line, plus padding.
	const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 55)), 0);
	return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, lines * 22 + 40));
}

export function newId(): string {
	// Canvas ids are opaque strings; Obsidian's own are 16 hex characters.
	return Array.from(crypto.getRandomValues(new Uint8Array(8)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function emptyCanvas(): CanvasData {
	return { nodes: [], edges: [] };
}

export async function readCanvas(vault: Vault, file: TFile): Promise<CanvasData> {
	const raw = await vault.read(file);
	if (!raw.trim()) return emptyCanvas();
	try {
		const parsed = JSON.parse(raw) as Partial<CanvasData>;
		return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
	} catch {
		// A canvas we can't parse is a canvas we must not overwrite — the user
		// has a file with content in it, whatever we think of the syntax.
		throw new Error(`${file.path} isn't valid canvas JSON`);
	}
}

export async function writeCanvas(vault: Vault, file: TFile, data: CanvasData): Promise<void> {
	// Two-space JSON, like Obsidian writes it: the file stays diffable in git,
	// which matters for anyone keeping a vault in version control.
	await vault.modify(file, JSON.stringify(data, null, 2));
}

export async function createCanvas(vault: Vault, folder: string, name: string): Promise<TFile> {
	const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Conversation";
	if (folder && !vault.getAbstractFileByPath(normalizePath(folder))) {
		await vault.createFolder(normalizePath(folder));
	}
	let path = normalizePath(folder ? `${folder}/${safe}.canvas` : `${safe}.canvas`);
	// Never clobber: a second conversation with the same title gets a suffix
	// rather than eating the first one.
	let counter = 2;
	while (vault.getAbstractFileByPath(path)) {
		path = normalizePath(folder ? `${folder}/${safe} ${counter}.canvas` : `${safe} ${counter}.canvas`);
		counter += 1;
	}
	return vault.create(path, JSON.stringify(emptyCanvas(), null, 2));
}

/**
 * Appends a node under `parentId` and wires the edge.
 *
 * Placement is the only layout logic here: directly below the parent, shifted
 * right for each sibling that already exists. Enough that a branch doesn't
 * land on top of its sibling, and no more — the user will drag things where
 * they want them, and Obsidian remembers.
 */
export function appendNode(
	data: CanvasData,
	parentId: string | null,
	text: string,
	color: string,
): CanvasNode {
	const parent = parentId ? data.nodes.find((n) => n.id === parentId) ?? null : null;
	const siblings = parentId ? data.edges.filter((e) => e.fromNode === parentId).length : data.nodes.filter((n) => !data.edges.some((e) => e.toNode === n.id)).length;

	const node: CanvasNode = {
		id: newId(),
		type: "text",
		text,
		x: parent ? parent.x + siblings * (NODE_WIDTH + COLUMN_GAP) : siblings * (NODE_WIDTH + COLUMN_GAP),
		y: parent ? parent.y + parent.height + ROW_GAP : 0,
		width: NODE_WIDTH,
		height: estimateHeight(text),
		color,
	};
	data.nodes.push(node);

	if (parentId) {
		data.edges.push({
			id: newId(),
			fromNode: parentId,
			fromSide: "bottom",
			toNode: node.id,
			toSide: "top",
		});
	}
	return node;
}

/**
 * The chain from a node up to its root, oldest first.
 *
 * This is the context a turn is sent with, and the reason branching works
 * without any bookkeeping of our own: the canvas already knows who a node's
 * parent is. Stops on a cycle rather than looping — a hand-edited canvas can
 * contain one, and hanging is a worse answer than a short chain.
 */
export function ancestry(data: CanvasData, nodeId: string): CanvasNode[] {
	const byId = new Map(data.nodes.map((n) => [n.id, n]));
	const parentOf = new Map(data.edges.map((e) => [e.toNode, e.fromNode]));

	const chain: CanvasNode[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = nodeId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const node = byId.get(cursor);
		if (!node) break;
		chain.push(node);
		cursor = parentOf.get(cursor);
	}
	return chain.reverse();
}

/** Nodes with no children — the live ends of a conversation. */
export function leaves(data: CanvasData): CanvasNode[] {
	const hasChild = new Set(data.edges.map((e) => e.fromNode));
	return data.nodes.filter((n) => !hasChild.has(n.id));
}

/** Direct children of a node, in the order their edges were written. */
export function childrenOf(data: CanvasData, nodeId: string): CanvasNode[] {
	const byId = new Map(data.nodes.map((n) => [n.id, n]));
	return data.edges
		.filter((e) => e.fromNode === nodeId)
		.map((e) => byId.get(e.toNode))
		.filter((n): n is CanvasNode => Boolean(n));
}

/**
 * Where the branch containing `nodeId` split off.
 *
 * The nearest ancestor with more than one child — the node where someone asked
 * the same thing two ways. That is the node a conclusion has to land on, because
 * it is the one every *future* branch will also hang from.
 *
 * A conversation with no fork yet answers with its root, which is the reading
 * that makes promote useful before you have branched at all: the root is where
 * you will start the next line from.
 */
export function forkPoint(data: CanvasData, nodeId: string): CanvasNode | null {
	const chain = ancestry(data, nodeId);
	// Excludes the node itself: promoting a branch into its own tip says nothing.
	for (let i = chain.length - 2; i >= 0; i -= 1) {
		if (childrenOf(data, chain[i].id).length > 1) return chain[i];
	}
	return chain[0] ?? null;
}

/** The nodes below `ancestorId` on the way down to `tipId`, oldest first. */
export function branchSince(data: CanvasData, ancestorId: string, tipId: string): CanvasNode[] {
	const chain = ancestry(data, tipId);
	const index = chain.findIndex((n) => n.id === ancestorId);
	return index === -1 ? chain : chain.slice(index + 1);
}

// A promoted conclusion is stored in the text of the node it was promoted to,
// wrapped in HTML comments.
//
// Storing it in the node's own text is what makes inheritance free: the context
// a turn is sent is already the chain up to the root, so a conclusion written
// into an ancestor is read by every branch opened under it afterwards, with no
// second mechanism and nothing for a hand-edited canvas to get out of step with.
// Obsidian renders HTML comments as nothing and a callout as a callout, so what
// the user sees on the canvas is a tidy block they can edit or delete by hand.
const PROMOTED_CLOSE = "<!-- /cymose:promoted -->";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips our bookkeeping comments. What the model reads is what a person reads. */
export function textForModel(text: string): string {
	return text.replace(/<!--\s*\/?cymose:[^>]*-->[ \t]*\n?/g, "").trim();
}

/**
 * Writes a branch's conclusion into `node`, replacing the previous conclusion
 * from that same branch rather than stacking a second copy under it.
 *
 * Keyed by the branch's tip: promoting the same branch again after three more
 * turns should update what it decided, while a *different* branch promoting into
 * the same node is a second conclusion and gets its own block.
 */
export function setPromoted(node: CanvasNode, branchId: string, title: string, digest: string): void {
	const open = `<!-- cymose:promoted:${branchId} -->`;
	const quoted = digest
		.trim()
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const block = `${open}\n> [!success] Promoted from “${title}”\n${quoted}\n${PROMOTED_CLOSE}`;

	const text = node.text ?? "";
	const existing = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(PROMOTED_CLOSE)}`);
	node.text = existing.test(text) ? text.replace(existing, block) : `${text.trimEnd()}\n\n${block}`.trim();
	node.height = estimateHeight(node.text);
}

/** A short label for a node, for pickers and menus. */
export function label(node: CanvasNode, max = 60): string {
	const text = (node.text ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "(empty)";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
