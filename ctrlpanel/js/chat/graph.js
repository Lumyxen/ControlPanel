import { generateId } from "./util.js";

export function createEmptyGraph() {
	const rootId = "root";
	return {
		version: 1,
		rootId,
		nodes: {
			[rootId]: {
				id: rootId,
				role: "system",
				content: "",
				timestamp: 0,
				parentId: null,
				children:[],
			},
		},
		selections: {},
		leafId: null,
	};
}

export function isGraphLike(graph) {
	return graph && typeof graph === "object" && typeof graph.rootId === "string" &&
		graph.nodes && typeof graph.nodes === "object" &&
		graph.selections && typeof graph.selections === "object";
}

export function ensureGraph(chat) {
	if (!chat) return null;
	if (isGraphLike(chat.graph)) {
		if (!chat.graph.nodes[chat.graph.rootId]) {
			chat.graph.nodes[chat.graph.rootId] = {
				id: chat.graph.rootId, role: "system", content: "", timestamp: 0,
				parentId: null, children:[],
			};
		}
		// Recompute leafId to ensure it's always valid after loading from storage
		recomputeLeafId(chat.graph);
		return chat.graph;
	}
	const graph = createEmptyGraph();
	const legacy = Array.isArray(chat.messages) ? chat.messages :[];
	let parentId = graph.rootId;
	legacy.forEach((m) => {
		const nodeId = generateId();
		const node = {
			id: nodeId,
			role: m?.role === "assistant" ? "assistant" : "user",
			content: String(m?.content || ""),
			timestamp: Number(m?.timestamp) || Date.now(),
			parentId,
			children:[],
		};
	       if (m.parts) node.parts = JSON.parse(JSON.stringify(m.parts));
	       if (m.attachments) node.attachments = JSON.parse(JSON.stringify(m.attachments));
	       if (m.reasoning) node.reasoning = m.reasoning;
	       
		graph.nodes[nodeId] = node;
		graph.nodes[parentId].children.push(nodeId);
		graph.selections[parentId] = nodeId;
		parentId = nodeId;
	});
	graph.leafId = parentId === graph.rootId ? null : parentId;
	chat.graph = graph;
	try { delete chat.messages; } catch {}
	return graph;
}

export function getNode(graph, nodeId) {
	return graph?.nodes?.[nodeId] || null;
}

export function getSelectedChildId(graph, parentId) {
	const parent = getNode(graph, parentId);
	if (!parent?.children?.length) return null;
	return parent.children.includes(graph.selections?.[parentId])
		? graph.selections[parentId]
		: parent.children[0];
}

export function setSelectedChildId(graph, parentId, childId) {
	const parent = getNode(graph, parentId);
	if (!parent?.children?.includes(childId)) return false;
	graph.selections[parentId] = childId;
	return true;
}

export function computeThreadNodeIds(graph) {
	const ids =[];
	if (!graph) return ids;
	let currentId = graph.rootId;
	const seen = new Set([currentId]);
	while (true) {
		const nextId = getSelectedChildId(graph, currentId);
		if (!nextId || seen.has(nextId)) break;
		ids.push(nextId);
		seen.add(nextId);
		currentId = nextId;
	}
	return ids;
}

export function recomputeLeafId(graph) {
	const path = computeThreadNodeIds(graph);
	graph.leafId = path.length ? path[path.length - 1] : null;
}

export function appendNode(graph, { parentId, role, content, timestamp, attachments, parts }) {
	const parent = getNode(graph, parentId);
	if (!parent) throw new Error("appendNode: parent not found");
	const id = generateId();
	const node = {
		id, role,
		timestamp: Number(timestamp) || Date.now(),
		parentId, children:[],
	};
	
	// Support both old format (content + attachments) and new format (parts)
	if (parts && Array.isArray(parts) && parts.length > 0) {
		node.parts = parts;
	} else {
		node.content = String(content ?? "");
		if (attachments && attachments.length > 0) {
			node.attachments = attachments;
		}
	}
	
	graph.nodes[id] = node;
	parent.children.push(id);
	setSelectedChildId(graph, parentId, id);
	graph.leafId = id;
	return node;
}

export function createSiblingCopy(graph, nodeId, { content, timestamp, parts, attachments, reasoning } = {}) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) return null;
	const parent = getNode(graph, node.parentId);
	if (!parent?.children) return null;
	const siblingId = generateId();
	const sibling = {
		id: siblingId,
		role: node.role,
		content: content !== undefined ? String(content) : String(node.content ?? ""),
		timestamp: Number(timestamp) || Date.now(),
		parentId: node.parentId,
		children:[],
		editedFrom: node.id,
	};
    
    // Default to copying existing parts/attachments if not explicitly provided
    if (parts !== undefined) {
        if (parts) sibling.parts = JSON.parse(JSON.stringify(parts));
    } else if (node.parts) {
        sibling.parts = JSON.parse(JSON.stringify(node.parts));
    }

    if (attachments !== undefined) {
        if (attachments) sibling.attachments = JSON.parse(JSON.stringify(attachments));
    } else if (node.attachments) {
        sibling.attachments = JSON.parse(JSON.stringify(node.attachments));
    }

    // Copy reasoning if present (use explicit value if provided, otherwise copy from node)
    if (reasoning !== undefined) {
        if (reasoning) sibling.reasoning = reasoning;
    } else if (node.reasoning) {
        sibling.reasoning = node.reasoning;
    }

	graph.nodes[siblingId] = sibling;
	parent.children.push(siblingId);
	setSelectedChildId(graph, node.parentId, siblingId);
	recomputeLeafId(graph);
	return sibling;
}

export function nodeHasGeneratedResponse(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node?.children?.length) return false;
	return node.children.some((childId) => getNode(graph, childId)?.role === "assistant");
}

export function branchFromNode(graph, nodeId, { preserveSelectedTail = false } = {}) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) return null;
	const parent = getNode(graph, node.parentId);
	if (!parent?.children) return null;
	const siblingId = generateId();
	const sibling = {
		id: siblingId, role: node.role,
		content: String(node.content ?? ""),
		timestamp: Date.now(),
		parentId: node.parentId,
		children:[],
		branchedFrom: node.id,
	};
    
    if (node.parts) sibling.parts = JSON.parse(JSON.stringify(node.parts));
    if (node.attachments) sibling.attachments = JSON.parse(JSON.stringify(node.attachments));
    if (node.reasoning) sibling.reasoning = node.reasoning;

	graph.nodes[siblingId] = sibling;
	parent.children.push(siblingId);
	setSelectedChildId(graph, node.parentId, siblingId);
	if (!preserveSelectedTail) {
		recomputeLeafId(graph);
		return sibling;
	}
	let prevNewId = siblingId;
	let currentOldId = nodeId;
	while (true) {
		const nextOldId = getSelectedChildId(graph, currentOldId);
		if (!nextOldId) break;
		const oldNext = getNode(graph, nextOldId);
		if (!oldNext) break;
		const newId = generateId();
		const cloned = {
			id: newId, role: oldNext.role,
			content: String(oldNext.content ?? ""),
			timestamp: oldNext.timestamp,
			parentId: prevNewId,
			children:[],
			clonedFrom: oldNext.id,
		};
        
        if (oldNext.parts) cloned.parts = JSON.parse(JSON.stringify(oldNext.parts));
        if (oldNext.attachments) cloned.attachments = JSON.parse(JSON.stringify(oldNext.attachments));
        if (oldNext.reasoning) cloned.reasoning = oldNext.reasoning;

		graph.nodes[newId] = cloned;
		graph.nodes[prevNewId].children.push(newId);
		graph.selections[prevNewId] = newId;
		prevNewId = newId;
		currentOldId = nextOldId;
	}
	recomputeLeafId(graph);
	return sibling;
}

export function deleteSubtree(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node) return;
	[...node.children].forEach((childId) => deleteSubtree(graph, childId));
	if (node.parentId) {
		const parent = getNode(graph, node.parentId);
		if (parent?.children) {
			parent.children = parent.children.filter((id) => id !== nodeId);
			if (graph.selections?.[parent.id] === nodeId) {
				const next = parent.children[0] || null;
				next ? (graph.selections[parent.id] = next) : delete graph.selections[parent.id];
			}
		}
	}
	delete graph.nodes[nodeId];
}

export function spliceDeleteNode(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) return false;
	const parent = getNode(graph, node.parentId);
	if (!parent?.children) return false;
	const idx = parent.children.indexOf(nodeId);
	if (idx === -1) return false;
	const children = node.children ? [...node.children] :[];
	children.forEach((childId) => {
		const child = getNode(graph, childId);
		if (child) child.parentId = parent.id;
	});
	parent.children.splice(idx, 1, ...children);
	if (graph.selections?.[parent.id] === nodeId) {
		const selectedChild = getSelectedChildId(graph, nodeId);
		if (selectedChild && children.includes(selectedChild)) {
			graph.selections[parent.id] = selectedChild;
		} else if (children[0]) {
			graph.selections[parent.id] = children[0];
		} else {
			delete graph.selections[parent.id];
		}
	}
	delete graph.nodes[nodeId];
	delete graph.selections[nodeId];
	recomputeLeafId(graph);
	return true;
}
