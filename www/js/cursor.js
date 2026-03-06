export function initCursor() {
	const cursor = document.getElementById("cursor");
	if (!cursor) return;

	const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const coarse = matchMedia("(pointer: coarse)").matches;
	if (reduce || coarse) return;

	let lastX = null;
	let lastY = null;
	const fromStore = sessionStorage.getItem("cursor-pos");
	if (fromStore) {
		try {
			const { x, y } = JSON.parse(fromStore);
			lastX = x;
			lastY = y;
		} catch {}
	}

	let x = lastX ?? innerWidth / 2;
	let y = lastY ?? innerHeight / 2;
	let scale = 1;

	const setTransform = (nx, ny) => {
		cursor.style.transform = `translate(${nx}px, ${ny}px) translate(-50%, -50%) scale(${scale})`;
	};
	setTransform(x, y);

	addEventListener("mousemove", e => {
		x = e.clientX;
		y = e.clientY;
		if (cursor.style.opacity !== "1") cursor.style.opacity = "1";
		setTransform(x, y);
	}, { passive: true });

	addEventListener("beforeunload", () => {
		try {
			sessionStorage.setItem("cursor-pos", JSON.stringify({ x, y }));
		} catch {}
	}, { once: true });

	const isLinkLike = el => {
		if (!el) return false;
		if (el.tagName === "A" || el.tagName === "BUTTON") return true;
		if (el.getAttribute && el.getAttribute("role") === "button") return true;
		return false;
	};
	const isGrowTarget = el => !!(el?.dataset?.cursor === "grow");

	let state = { grow: false, shrink: false, selecting: false };

	const applyScale = () => {
		if (state.selecting) {
			scale = 1;
		} else if (state.grow) {
			scale = 1.35;
		} else if (state.shrink) {
			scale = 0.8;
		} else {
			scale = 1;
		}
		setTransform(x, y);
	};

	const setState = next => {
		if (next.grow !== state.grow) cursor.classList.toggle("grow", next.grow);
		if (next.shrink !== state.shrink) cursor.classList.toggle("shrink", next.shrink);
		if (next.selecting !== state.selecting) cursor.classList.toggle("selecting", next.selecting);
		state = next;
		applyScale();
	};

	document.addEventListener("mouseover", e => {
		const el = e.target.closest("[data-cursor], a, button, [role='button']");
		const next = { ...state };
		if (isGrowTarget(el)) {
			next.grow = true;
			next.shrink = false;
		} else if (isLinkLike(el)) {
			next.grow = false;
			next.shrink = true;
		} else {
			next.grow = false;
			next.shrink = false;
		}
		setState(next);
	}, { passive: true });

	document.addEventListener("mouseout", () => setState({ ...state, grow: false, shrink: false }), { passive: true });

	const hasSelection = () => {
		const sel = getSelection();
		if (!sel || sel.rangeCount === 0) return false;
		for (let i = 0; i < sel.rangeCount; i++) {
			if (!sel.getRangeAt(i).collapsed) return true;
		}
		return false;
	};

	addEventListener("mouseup", () => setState({ ...state, selecting: hasSelection() }), { passive: true });
	document.addEventListener("selectionchange", () => setState({ ...state, selecting: hasSelection() }));
	addEventListener("contextmenu", () => setState({ ...state, selecting: false }));

	addEventListener("blur", () => cursor.style.opacity = "0");
	addEventListener("focus", () => cursor.style.opacity = "1");
}
