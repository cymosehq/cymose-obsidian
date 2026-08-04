import { requestUrl } from "obsidian";
import { estimateHeight, newId, NODE_WIDTH, type CanvasData, type CanvasNode } from "./canvas";

// Pulling a tree down from Cymose Web.
//
// The plan lives in the browser: you sketch a problem on the web canvas,
// branch it three ways, promote what survived. Then you come here to write the
// thing out properly — and until now that meant retyping it, which is exactly
// the copy-paste this whole product exists to abolish.
//
// So: read the web tree, mirror it onto an Obsidian canvas, and let the
// conversation continue from any node in it.
//
// Read-only, deliberately. Pull before push — an import has no conflict
// resolution to get wrong, and this direction is the one that hurts every day.
// Nothing here writes back to the server; a mirrored node you edit in Obsidian
// stays in Obsidian.
//
// Contract: GET /v1/sync/tree, documented in cymose-code/docs/api-contract.md.

/** Tree format this build speaks. Sent by the server as `version`. */
export const SYNC_VERSION = 1;

export type SyncNote = { id: string; title: string; in_context: boolean; updated_at: string };

export type SyncNode = {
	id: string;
	parent_id: string | null;
	title: string;
	inherited_summary: string | null;
	promoted_digest: string | null;
	pinned?: boolean;
	position?: { x: number; y: number } | null;
	notes?: SyncNote[];
	created_at: string;
};

export type SyncTree = { version: number; synced_at?: string; nodes: SyncNode[] };

/**
 * Which Obsidian node mirrors which Cymose node, per canvas file.
 *
 * Kept in plugin data rather than on the canvas nodes themselves. JSON Canvas
 * says implementations should preserve properties they don't recognise, and
 * Obsidian does — but "should" is not "will", and a mapping that evaporates on
 * some future release would turn every re-pull into a duplicate tree. Ours to
 * store, ours to keep.
 */
export type SyncMap = Record<string, Record<string, string>>;

export class SyncError extends Error {}

/** Reads the caller's whole tree. Throws SyncError with something sayable. */
export async function fetchTree(baseUrl: string, token: string): Promise<SyncTree> {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) throw new SyncError("No Cymose API address is set.");
	if (!token.trim()) throw new SyncError("No Cymose access token is set.");

	let response;
	try {
		// requestUrl rather than fetch: Obsidian's helper is not subject to the
		// renderer's CORS rules, and a plugin calling a third-party origin with
		// fetch fails on desktop for reasons the user cannot act on.
		response = await requestUrl({
			url: `${base}/v1/sync/tree`,
			method: "GET",
			headers: { Authorization: `Bearer ${token.trim()}` },
			// We want to read the body of a 401 rather than have it thrown at us.
			throw: false,
		});
	} catch (error) {
		throw new SyncError(`Couldn't reach Cymose: ${(error as Error).message}`);
	}

	if (response.status === 401) throw new SyncError("That access token was rejected. Create a new one at web.cymose.app under Settings → Connected apps.");
	if (response.status >= 400) throw new SyncError(`Cymose returned ${response.status}.`);

	let tree: SyncTree;
	try {
		tree = response.json as SyncTree;
	} catch {
		throw new SyncError("Cymose sent something that isn't a tree.");
	}
	if (!tree || !Array.isArray(tree.nodes)) throw new SyncError("Cymose sent something that isn't a tree.");

	// A build that meets a format it doesn't know has to refuse rather than
	// guess. A mis-read parent pointer is a reparented branch, and the user
	// would find that out by seeing their work in the wrong place.
	if (tree.version !== SYNC_VERSION) {
		throw new SyncError(
			`This plugin reads tree format v${SYNC_VERSION}; Cymose sent v${tree.version}. Update the plugin.`,
		);
	}
	return tree;
}

/** Root nodes — one conversation each, and what the picker offers. */
export function roots(tree: SyncTree): SyncNode[] {
	const ids = new Set(tree.nodes.map((n) => n.id));
	// A node whose parent isn't in the response is a root as far as we can see.
	// Better than dropping it: an orphan drawn at the top level is visible and
	// fixable, an orphan silently omitted is a branch the user lost.
	return tree.nodes.filter((n) => !n.parent_id || !ids.has(n.parent_id));
}

/** A node and everything under it, parents before children. */
export function subtree(tree: SyncTree, rootId: string): SyncNode[] {
	const childrenOf = new Map<string, SyncNode[]>();
	for (const node of tree.nodes) {
		if (!node.parent_id) continue;
		const bucket = childrenOf.get(node.parent_id) ?? [];
		bucket.push(node);
		childrenOf.set(node.parent_id, bucket);
	}
	const start = tree.nodes.find((n) => n.id === rootId);
	if (!start) return [];

	const out: SyncNode[] = [];
	const seen = new Set<string>();
	const queue: SyncNode[] = [start];
	while (queue.length) {
		const node = queue.shift() as SyncNode;
		// A cycle can only come from a corrupt response, but hanging is a worse
		// answer than a short tree.
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		out.push(node);
		queue.push(...(childrenOf.get(node.id) ?? []));
	}
	return out;
}

/**
 * What a mirrored node says.
 *
 * Titles, the promoted conclusion, and the names of any notes pinned there —
 * the things that tell you what a branch *decided*. Not the transcript: the
 * export doesn't carry message bodies, and a canvas of full conversations
 * would be unreadable at the zoom level where a tree is useful anyway.
 */
export function nodeText(node: SyncNode): string {
	const parts = [`## ${node.title || "Untitled"}`];
	if (node.promoted_digest?.trim()) {
		parts.push(`**Promoted up from its branches:**\n${node.promoted_digest.trim()}`);
	}
	const notes = (node.notes ?? []).filter((n) => n.title?.trim());
	if (notes.length) {
		parts.push(
			`**Notes pinned here:**\n${notes
				.map((n) => `- ${n.title}${n.in_context ? "" : " _(not in context)_"}`)
				.join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

const COLUMN_GAP = 60;
const ROW_GAP = 90;

/**
 * Mirrors a subtree onto a canvas, in place.
 *
 * Idempotent: a node already mirrored is updated where it stands rather than
 * added again, so re-pulling after a week of work on the web reflects the
 * changes instead of stacking a second copy on top of the first. Anything the
 * user dragged keeps its position — the layout below is only for nodes being
 * placed for the first time.
 *
 * Nodes deleted on the web are left alone rather than removed. This is a
 * mirror, not a replica, and silently deleting something out of a person's
 * vault because a server no longer mentions it is not a trade worth making.
 */
export function mirrorSubtree(
	data: CanvasData,
	nodes: SyncNode[],
	map: Record<string, string>,
): { added: number; updated: number } {
	const byCanvasId = new Map(data.nodes.map((n) => [n.id, n]));
	const depthOf = new Map<string, number>();
	const placedAtDepth = new Map<number, number>();
	let added = 0;
	let updated = 0;

	for (const node of nodes) {
		const depth = node.parent_id && depthOf.has(node.parent_id) ? (depthOf.get(node.parent_id) as number) + 1 : 0;
		depthOf.set(node.id, depth);

		const text = nodeText(node);
		const existingId = map[node.id];
		const existing = existingId ? byCanvasId.get(existingId) : undefined;

		if (existing) {
			// Height follows the text; x/y do not, because the user may have
			// moved it and their arrangement outranks ours.
			existing.text = text;
			existing.height = estimateHeight(text);
			updated += 1;
			continue;
		}

		const column = placedAtDepth.get(depth) ?? 0;
		placedAtDepth.set(depth, column + 1);

		const canvasNode: CanvasNode = {
			id: newId(),
			type: "text",
			text,
			x: column * (NODE_WIDTH + COLUMN_GAP),
			y: depth * (estimateHeight(text) + ROW_GAP),
			width: NODE_WIDTH,
			height: estimateHeight(text),
		};
		data.nodes.push(canvasNode);
		byCanvasId.set(canvasNode.id, canvasNode);
		map[node.id] = canvasNode.id;
		added += 1;

		const parentCanvasId = node.parent_id ? map[node.parent_id] : undefined;
		if (parentCanvasId && byCanvasId.has(parentCanvasId)) {
			const alreadyWired = data.edges.some(
				(e) => e.fromNode === parentCanvasId && e.toNode === canvasNode.id,
			);
			if (!alreadyWired) {
				data.edges.push({
					id: newId(),
					fromNode: parentCanvasId,
					fromSide: "bottom",
					toNode: canvasNode.id,
					toSide: "top",
				});
			}
		}
	}

	return { added, updated };
}
