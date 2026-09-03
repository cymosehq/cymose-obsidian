import { describe, it, expect, vi } from "vitest";

// Mock the obsidian module before importing canvas.ts
vi.mock("obsidian", () => ({
	normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
}));

import {
	estimateHeight,
	newId,
	emptyCanvas,
	appendNode,
	removeNode,
	ancestry,
	leaves,
	childrenOf,
	forkPoint,
	branchSince,
	textForModel,
	withModelTag,
	setPromoted,
	sanitizeCanvasMarkers,
	CanvasNode
} from "./canvas";

describe("Canvas Layout & Utils", () => {
	it("estimates height based on text length", () => {
		expect(estimateHeight("")).toBe(120); // MIN_HEIGHT
		expect(estimateHeight("Short line")).toBe(120);
		
		const longText = Array(20).fill("This is a fairly long line that wraps.").join("\n");
		expect(estimateHeight(longText)).toBeGreaterThan(120);
		expect(estimateHeight(longText)).toBeLessThanOrEqual(640); // MAX_HEIGHT
	});

	it("generates 16-hex-char unique IDs", () => {
		const id = newId();
		expect(id).toMatch(/^[0-9a-f]{16}$/);
		expect(id).not.toBe(newId());
	});
});

describe("appendNode placement", () => {
	it("never lands a node on top of one that is already there", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		// Three children of one node: the fork this product exists to make.
		const kids = [
			appendNode(data, root.id, "one", "5"),
			appendNode(data, root.id, "two", "5"),
			appendNode(data, root.id, "three", "5"),
		];
		const xs = kids.map((k) => k.x);
		expect(new Set(xs).size).toBe(3);
		expect(xs).toEqual([...xs].sort((a, b) => a - b));
	});

	it("steps clear of an unrelated node sitting where the new one would go", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		const row = root.y + root.height + 80; // ROW_GAP

		// Something already occupying the spot directly under the root — another
		// conversation on the same canvas, or a node the user dragged there.
		data.nodes.push({
			id: "squatter",
			type: "text",
			x: root.x,
			y: row,
			width: 420,
			height: 120,
			text: "in the way",
		});

		const child = appendNode(data, root.id, "child", "5");
		expect(child.y).toBe(row);
		// Not on top of it: either clear to the right, or clear to the left.
		const clear = child.x >= 420 + root.x || child.x + 420 <= root.x;
		expect(clear).toBe(true);
	});
});

describe("removeNode", () => {
	it("takes the node and every edge touching it", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		const answer = appendNode(data, root.id, "…", "5");
		const child = appendNode(data, answer.id, "Follow-up", "6");

		removeNode(data, answer.id);

		expect(data.nodes.map((n) => n.id)).toEqual([root.id, child.id]);
		// Both sides: the edge down from the parent AND the one on to the child.
		// Leaving either behind is an edge pointing at nothing.
		expect(data.edges).toHaveLength(0);
	});

	it("is a no-op for a node that isn't there", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		removeNode(data, "nope");
		expect(data.nodes).toHaveLength(1);
		expect(data.nodes[0].id).toBe(root.id);
	});
});

describe("Canvas Graph Operations", () => {
	it("appends nodes and creates edges", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		expect(data.nodes.length).toBe(1);
		expect(data.edges.length).toBe(0);

		const child = appendNode(data, root.id, "Child", "5");
		expect(data.nodes.length).toBe(2);
		expect(data.edges.length).toBe(1);
		expect(data.edges[0].fromNode).toBe(root.id);
		expect(data.edges[0].toNode).toBe(child.id);
	});

	it("computes ancestry, leaves, and children", () => {
		const data = emptyCanvas();
		// root -> A -> B
		//      -> C
		const root = appendNode(data, null, "Root", "6");
		const a = appendNode(data, root.id, "A", "5");
		const b = appendNode(data, a.id, "B", "6");
		const c = appendNode(data, root.id, "C", "5");

		// Ancestry
		const chainB = ancestry(data, b.id);
		expect(chainB.map(n => n.id)).toEqual([root.id, a.id, b.id]);

		const chainC = ancestry(data, c.id);
		expect(chainC.map(n => n.id)).toEqual([root.id, c.id]);

		// Leaves
		const leafNodes = leaves(data);
		expect(leafNodes.map(n => n.id).sort()).toEqual([b.id, c.id].sort());

		// Children
		const rootChildren = childrenOf(data, root.id);
		expect(rootChildren.map(n => n.id)).toEqual([a.id, c.id]);
	});

	it("finds the correct fork point", () => {
		const data = emptyCanvas();
		// root -> A -> B
		//      -> C
		const root = appendNode(data, null, "Root", "6");
		const a = appendNode(data, root.id, "A", "5");
		const b = appendNode(data, a.id, "B", "6");
		const c = appendNode(data, root.id, "C", "5");

		// Branch B splits at Root
		expect(forkPoint(data, b.id)?.id).toBe(root.id);
		// Branch C splits at Root
		expect(forkPoint(data, c.id)?.id).toBe(root.id);

		// If a branch has no fork yet, it returns root
		const linearData = emptyCanvas();
		const root2 = appendNode(linearData, null, "Root", "6");
		const a2 = appendNode(linearData, root2.id, "A", "5");
		expect(forkPoint(linearData, a2.id)?.id).toBe(root2.id);
	});

	it("extracts branchSince", () => {
		const data = emptyCanvas();
		const root = appendNode(data, null, "Root", "6");
		const a = appendNode(data, root.id, "A", "5");
		const b = appendNode(data, a.id, "B", "6");

		const branch = branchSince(data, root.id, b.id);
		expect(branch.map(n => n.id)).toEqual([a.id, b.id]);
	});
});

describe("Canvas Text Formatting", () => {
	it("strips bookkeeping comments for textForModel", () => {
		const text = "Hello world.\n\n<!-- cymose:model -->\n*— gpt-4*\n<!-- /cymose:model -->";
		expect(textForModel(text)).toBe("Hello world.");

		const textWithPromoted = "Start\n\n<!-- cymose:promoted:123 -->\n> [!success] Promoted\n> Conclusion\n<!-- /cymose:promoted -->";
		// The tag itself is stripped but the human readable content (> [!success] ...) remains
		const stripped = textForModel(textWithPromoted);
		expect(stripped).toContain("> [!success] Promoted");
		expect(stripped).toContain("> Conclusion");
		expect(stripped).not.toContain("cymose:promoted");
	});

	it("adds a model tag", () => {
		const text = "This is my answer.";
		const tagged = withModelTag(text, "gpt-4");
		expect(tagged).toContain("This is my answer.");
		expect(tagged).toContain("<!-- cymose:model -->");
		expect(tagged).toContain("*— gpt-4*");
	});

	it("sets promoted conclusion", () => {
		const node: CanvasNode = { id: "n1", type: "text", x: 0, y: 0, width: 400, height: 100, text: "Original text." };
		
		setPromoted(node, "b1", "Branch 1", "Found a solution.");
		expect(node.text).toContain("Original text.");
		expect(node.text).toContain("<!-- cymose:promoted:b1 -->");
		expect(node.text).toContain("> Found a solution.");

		// Overwriting the same branch conclusion
		setPromoted(node, "b1", "Branch 1", "Updated solution.");
		expect(node.text).not.toContain("Found a solution.");
		expect(node.text).toContain("Updated solution.");
		expect(node.text?.match(/cymose:promoted:b1/g)?.length).toBe(1);

		// Another branch conclusion appends
		setPromoted(node, "b2", "Branch 2", "Another solution.");
		expect(node.text).toContain("Updated solution.");
		expect(node.text).toContain("Another solution.");
		expect(node.text).toContain("<!-- cymose:promoted:b1 -->");
		expect(node.text).toContain("<!-- cymose:promoted:b2 -->");
	});

	it("sanitizeCanvasMarkers strips control tokens from text nodes", () => {
		const data = emptyCanvas();
		const node = appendNode(data, null, "Hello ⟦SWITCH:model⟧ world ⟦TRUNCATED⟧", "5");
		expect(sanitizeCanvasMarkers(data)).toBe(true);
		expect(node.text).toBe("Hello  world ");
	});
});
