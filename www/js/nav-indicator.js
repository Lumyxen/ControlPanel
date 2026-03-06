let _state = {
	inited: false,
	navEl: null,
	layer: null,
	svg: null,
	travelPath: null,
	idlePath: null,
	currentEl: null,
	currentRoute: null,
	reduceMotion: false,
	travelAnim: null,
	onTransitionEnd: null,
	animToken: 0
};

const CFG = {
	strokeWidth: 2,
	barOffset: 4,
	barScale: 0.58,
	barMinH: 10,
	barMaxH: 18,
	horizontalClear: 2,
	bottomGuard: 10,
	durationMs: 350
};

function ensureInit() {
	if (_state.inited) return;

	_state.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
	_state.navEl = document.querySelector("header .nav");
	if (!_state.navEl) return;

	_state.layer = document.createElement("div");
	_state.layer.id = "nav-indicator-layer";
	_state.layer.setAttribute("aria-hidden", "true");
	_state.navEl.insertBefore(_state.layer, _state.navEl.firstChild);

	_state.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	_state.svg.setAttribute("id", "nav-indicator-svg");
	_state.svg.setAttribute("width", "100%");
	_state.svg.setAttribute("height", "100%");
	_state.svg.setAttribute("preserveAspectRatio", "none");
	_state.layer.appendChild(_state.svg);

	_state.idlePath = createPath("nav-idle-path");
	_state.idlePath.style.opacity = "0";
	_state.svg.appendChild(_state.idlePath);

	_state.travelPath = createPath("nav-snake-path");
	_state.travelPath.style.opacity = "0";
	_state.svg.appendChild(_state.travelPath);

	updateViewBox();

	addEventListener("resize", () => {
		updateViewBox();
		cancelAnimation();
		if (_state.currentEl) showIdleAt(_state.currentEl);
	});

	_state.inited = true;
}

function createPath(id) {
	const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
	p.setAttribute("id", id);
	p.setAttribute("fill", "none");
	p.setAttribute("stroke", "currentColor");
	p.setAttribute("stroke-width", String(CFG.strokeWidth));
	p.setAttribute("stroke-linecap", "butt");
	p.setAttribute("stroke-linejoin", "bevel");
	p.setAttribute("stroke-miterlimit", "1");
	p.setAttribute("vector-effect", "non-scaling-stroke");
	p.style.transition = "none";
	p.style.willChange = "stroke-dashoffset, opacity";
	return p;
}

function updateViewBox() {
	if (!_state.navEl || !_state.svg) return;
	const r = _state.navEl.getBoundingClientRect();
	const w = Math.max(1, Math.round(r.width));
	const h = Math.max(1, Math.round(r.height));
	_state.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
}

function getRouteEl(name) {
	if (!name) return null;
	const scope = document.querySelector("header") || document;
	let el = scope.querySelector(`#top-nav a[data-route="${name}"]`) || scope.querySelector(`.id a[data-route="${name}"]`);
	return el || null;
}

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function measureFor(el) {
	if (!_state.navEl || !el) return null;
	const navR = _state.navEl.getBoundingClientRect();
	const r = el.getBoundingClientRect();

	const scaled = Math.round(r.height * CFG.barScale);
	const barH = clamp(scaled, CFG.barMinH, CFG.barMaxH);

	const centerY = Math.round(r.top - navR.top + r.height / 2);
	const top = Math.round(centerY - barH / 2);
	const bottom = top + barH;

	const x = Math.round(r.left - navR.left - CFG.barOffset);

	return { barH, centerY, x, top, bottom, navH: Math.round(navR.height) };
}

function showIdleAt(el) {
	const m = measureFor(el);
	if (!m || !_state.idlePath || !_state.travelPath) return;

	const idleD = `M ${m.x} ${m.top} L ${m.x} ${m.bottom}`;

	const idle = _state.idlePath;
	idle.setAttribute("d", idleD);
	idle.style.opacity = "1";

	const travel = _state.travelPath;
	travel.style.opacity = "0";
	travel.style.strokeDasharray = "none";
	travel.style.strokeDashoffset = "0";
	travel.style.transition = "none";
}

function cancelAnimation() {
	if (_state.travelAnim) {
		try {
			_state.travelAnim.cancel();
		} catch {}
		_state.travelAnim = null;
	}
	const travel = _state.travelPath;
	if (travel) {
		if (_state.onTransitionEnd) {
			try {
				travel.removeEventListener("transitionend", _state.onTransitionEnd);
			} catch {}
			_state.onTransitionEnd = null;
		}
		travel.style.transition = "none";
		travel.style.opacity = "0";
		travel.style.strokeDasharray = "none";
		travel.style.strokeDashoffset = "0";
	}
}

function buildSnakePath(fromEl, toEl) {
	updateViewBox();

	const from = measureFor(fromEl);
	const to = measureFor(toEl);
	if (!from || !to) return { d: "", fromM: from, toM: to };

	const sx = from.x;
	const sTop = from.top;
	const sBottom = from.bottom;

	const ex = to.x;
	const eTop = to.top;
	const eBottom = to.bottom;

	const navH = Math.max(from.navH, to.navH);

	const lowerBound = Math.max(sBottom + 1, eTop + 1);
	const desired = Math.max(sBottom + CFG.horizontalClear, eTop + CFG.horizontalClear);
	let yBase = clamp(desired, lowerBound, navH - CFG.bottomGuard);
	yBase = Math.round(yBase);

	const d = [
		`M ${sx} ${sTop}`,
		`L ${sx} ${sBottom}`,
		`L ${sx} ${yBase}`,
		`L ${ex} ${yBase}`,
		`L ${ex} ${eTop}`,
		`L ${ex} ${eBottom}`
	].join(" ");

	return { d, fromM: from, toM: to };
}

function commitToIdleAt(el) {
	const m = measureFor(el);
	if (!m || !_state.idlePath || !_state.travelPath) return;

	const idle = _state.idlePath;
	const travel = _state.travelPath;

	idle.setAttribute("d", `M ${m.x} ${m.top} L ${m.x} ${m.bottom}`);
	idle.style.opacity = "1";

	requestAnimationFrame(() => {
		travel.style.opacity = "0";
		requestAnimationFrame(() => {
			travel.style.strokeDasharray = "none";
			travel.style.strokeDashoffset = "0";
			travel.style.transition = "none";
		});
	});
}

function animateSnake(fromEl, toEl) {
	if (_state.reduceMotion) {
		showIdleAt(toEl);
		_state.currentEl = toEl;
		return;
	}

	const myToken = ++_state.animToken;
	cancelAnimation();

	const built = buildSnakePath(fromEl, toEl);
	if (!built.d) {
		showIdleAt(toEl);
		_state.currentEl = toEl;
		return;
	}

	const { d, toM } = built;
	const travel = _state.travelPath;
	const idle = _state.idlePath;

	idle.style.opacity = "0";

	travel.setAttribute("d", d);
	travel.style.opacity = "1";
	travel.style.transition = "none";

	let pathLen = 0;
	try {
		pathLen = travel.getTotalLength();
	} catch {
		pathLen = 0;
	}
	if (!(pathLen > 0)) {
		showIdleAt(toEl);
		_state.currentEl = toEl;
		return;
	}

	const segLen = clamp(toM?.barH ?? CFG.barMinH, CFG.barMinH, CFG.barMaxH);

	if (segLen >= pathLen - 0.5) {
		commitToIdleAt(toEl);
		_state.currentEl = toEl;
		return;
	}

	travel.style.strokeDasharray = `${segLen} ${pathLen}`;
	travel.style.strokeDashoffset = "0";

	const ms = CFG.durationMs;
	const finalOffset = -(pathLen - segLen);

	if (typeof travel.animate === "function") {
		_state.travelAnim = travel.animate(
			[{ strokeDashoffset: 0 }, { strokeDashoffset: finalOffset }],
			{ duration: ms, easing: "linear", fill: "forwards" }
		);

		_state.travelAnim.onfinish = () => {
			if (myToken !== _state.animToken) return;
			commitToIdleAt(toEl);
			_state.travelAnim = null;
		};
		_state.travelAnim.oncancel = () => {
			travel.style.opacity = "0";
			travel.style.strokeDasharray = "none";
			travel.style.strokeDashoffset = "0";
		};
	} else {
		requestAnimationFrame(() => {
			travel.style.transition = `stroke-dashoffset ${ms}ms linear`;
			void travel.getBoundingClientRect();
			travel.style.strokeDashoffset = String(finalOffset);

			const onEnd = e => {
				const prop = e.propertyName || "";
				if (prop === "stroke-dashoffset" || prop === "strokeDashoffset" || prop === "") {
					travel.removeEventListener("transitionend", onEnd);
					_state.onTransitionEnd = null;
					if (myToken !== _state.animToken) return;
					commitToIdleAt(toEl);
				}
			};
			_state.onTransitionEnd = onEnd;
			travel.addEventListener("transitionend", onEnd);
		});
	}

	_state.currentEl = toEl;
}

export function setActiveRoute(name) {
	ensureInit();
	if (!_state.inited) return;

	const targetEl = getRouteEl(name);
	if (!targetEl) return;

	if (!_state.currentEl) {
		showIdleAt(targetEl);
		_state.currentEl = targetEl;
		_state.currentRoute = name;
		return;
	}

	if (_state.currentEl === targetEl && _state.currentRoute === name) {
		showIdleAt(targetEl);
		return;
	}

	animateSnake(_state.currentEl, targetEl);
	_state.currentRoute = name;
}
