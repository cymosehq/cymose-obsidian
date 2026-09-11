import type { App, WorkspaceLeaf } from "obsidian";

/**
 * The guarded bridge to the live canvas view.
 *
 * Obsidian exposes no public API for what is selected on a canvas. That fact
 * used to be the end of the argument here, and the panel asked you to find the
 * node again in a dropdown — which meant the one interaction this product
 * exists for (point at a node, branch from it) was the worst thing in it.
 *
 * So we reach in, under three rules that keep the original concern honest:
 *
 * 1. **Every access is feature-detected and wrapped.** Nothing below assumes a
 *    shape. A missing property, a renamed method, a thrown getter — all of it
 *    comes back as `null`/`false`, never as an exception reaching a caller.
 * 2. **There is always a fallback.** Every caller must work when this module
 *    reports nothing, and the panel keeps its explicit picker for exactly that
 *    case. A bad Obsidian release costs you the convenience, not the plugin.
 * 3. **Read mostly, write narrowly.** We read the selection and we ask the view
 *    to select or reveal a node. We never mutate canvas data through here —
 *    that still goes through the `.canvas` file, which is the storage.
 *
 * If a future Obsidian publishes a real canvas API, this file is the only
 * place that has to change.
 */

/** The shape we hope for. Every field optional — this is a guess about someone
 *  else's internals, and the code below treats it as one. */
type InternalNode = {
	id?: unknown;
	x?: unknown;
	y?: unknown;
	width?: unknown;
	height?: unknown;
};

type InternalCanvas = {
	selection?: Set<InternalNode> | InternalNode[];
	nodes?: Map<string, InternalNode> | Record<string, InternalNode>;
	selectOnly?: (node: InternalNode) => void;
	deselectAll?: () => void;
	zoomToSelection?: () => void;
	requestFrame?: () => void;
};

type CanvasHost = { canvas?: InternalCanvas };

/** Anything at all went wrong reading someone else's internals: report nothing. */
function attempt<T>(read: () => T): T | null {
	try {
		return read();
	} catch {
		return null;
	}
}

/** The canvas behind a leaf, or null if that leaf isn't a canvas we understand. */
function canvasOf(leaf: WorkspaceLeaf | null): InternalCanvas | null {
	if (!leaf) return null;
	return attempt(() => {
		const view = leaf.view as unknown as CanvasHost & { getViewType?: () => string };
		if (typeof view?.getViewType === "function" && view.getViewType() !== "canvas") return null;
		const canvas = view?.canvas;
		return canvas && typeof canvas === "object" ? canvas : null;
	});
}

/**
 * The canvas the user is looking at, if it is a canvas.
 *
 * Clicking in the side panel makes the panel the active leaf, so "active" alone
 * would lose the canvas the moment you came over to type. `getMostRecentLeaf`
 * is the one that still means "the document you are working in" after that —
 * and only then do we fall back to any open canvas at all, which is right when
 * exactly one is open and a guess when several are.
 */
function activeCanvas(app: App): InternalCanvas | null {
	const recent = attempt(() => canvasOf(app.workspace.getMostRecentLeaf() ?? null));
	if (recent) return recent;

	return attempt(() => {
		const canvases = app.workspace.getLeavesOfType("canvas");
		// Several open and none of them recent: any answer is a guess, and a
		// wrong guess retargets the panel to a conversation the user isn't
		// looking at. Say nothing instead; the picker still works.
		if (canvases.length !== 1) return null;
		return canvasOf(canvases[0]);
	});
}

/** True when the internals are shaped the way we expect. Callers use it to
 *  decide whether to offer selection-driven UI at all. */
export function canvasBridgeWorks(app: App): boolean {
	const canvas = activeCanvas(app);
	if (!canvas) return false;
	return attempt(() => canvas.selection !== undefined && typeof canvas.selectOnly === "function") ?? false;
}

function idsOf(selection: Set<InternalNode> | InternalNode[] | undefined): string[] {
	if (!selection) return [];
	const list = Array.isArray(selection) ? selection : Array.from(selection);
	return list
		.map((node) => (typeof node?.id === "string" ? node.id : null))
		.filter((id): id is string => Boolean(id));
}

/**
 * Which nodes are selected on the canvas in front of the user.
 *
 * An empty array means "nothing selected" *or* "we couldn't tell" — the two are
 * deliberately the same answer, because every caller treats them the same way:
 * fall back to what the panel was already pointed at.
 */
export function selectedNodeIds(app: App): string[] {
	const canvas = activeCanvas(app);
	if (!canvas) return [];
	return attempt(() => idsOf(canvas.selection)) ?? [];
}

/** The single selected node, or null when zero or several are selected. */
export function selectedNodeId(app: App): string | null {
	const ids = selectedNodeIds(app);
	return ids.length === 1 ? ids[0] : null;
}

/**
 * Selects a node on the canvas, and optionally moves the view to it.
 *
 * The two are deliberately separate. Moving the view is right when the user
 * asked to be taken somewhere — they clicked the node's name in the panel, or
 * picked it out of a list — and wrong every other time: a turn that zoomed the
 * board to fill the screen with the node it had just created would throw away
 * whatever the user had arranged in order to show them something that is
 * already, by construction, just below what they were looking at.
 *
 * Returns false when we couldn't — callers fall back to saying it in words.
 */
function pointAt(app: App, nodeId: string, moveView: boolean): boolean {
	const canvas = activeCanvas(app);
	if (!canvas) return false;
	return (
		attempt(() => {
			const nodes = canvas.nodes;
			const node =
				nodes instanceof Map
					? nodes.get(nodeId)
					: nodes && typeof nodes === "object"
						? (nodes as Record<string, InternalNode>)[nodeId]
						: undefined;
			if (!node || typeof canvas.selectOnly !== "function") return false;
			canvas.selectOnly(node);
			if (moveView && typeof canvas.zoomToSelection === "function") canvas.zoomToSelection();
			else if (typeof canvas.requestFrame === "function") canvas.requestFrame();
			return true;
		}) ?? false
	);
}

/** Highlights a node where it already is. The board does not move. */
export function selectNode(app: App, nodeId: string): boolean {
	return pointAt(app, nodeId, false);
}

/** Takes the user to a node. Only ever from an explicit "show me that one". */
export function revealNode(app: App, nodeId: string): boolean {
	return pointAt(app, nodeId, true);
}
