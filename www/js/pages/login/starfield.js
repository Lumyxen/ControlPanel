const TWO_PI = Math.PI * 2;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const HORIZON_WARM = { r: 255, g: 216, b: 176 };
const STAR_WHITE = { r: 246, g: 248, b: 255 };

const SPECTRAL_CLASSES = normalizeWeights([
	// Solar-neighborhood densities adapted from Mamajek's stellar census and
	// normalized to the OBAFGKM main-sequence population.
	{ id: 'O', weight: 0.0000005, tempMin: 30000, tempMax: 45000, size: [0.82, 1.15], brightness: [0.9, 1.15] },
	{ id: 'B', weight: 0.00039, tempMin: 10000, tempMax: 30000, size: [0.76, 1.08], brightness: [0.74, 1.04] },
	{ id: 'A', weight: 0.006, tempMin: 7500, tempMax: 10000, size: [0.62, 0.96], brightness: [0.48, 0.82] },
	{ id: 'F', weight: 0.031, tempMin: 6000, tempMax: 7500, size: [0.52, 0.88], brightness: [0.32, 0.68] },
	{ id: 'G', weight: 0.059, tempMin: 5200, tempMax: 6000, size: [0.46, 0.8], brightness: [0.24, 0.56] },
	{ id: 'K', weight: 0.129, tempMin: 3700, tempMax: 5200, size: [0.42, 0.74], brightness: [0.18, 0.46] },
	{ id: 'M', weight: 0.725, tempMin: 2400, tempMax: 3700, size: [0.34, 0.66], brightness: [0.1, 0.34] },
]);

const CLUSTER_YOUNG_CLASSES = normalizeWeights([
	{ id: 'B', weight: 0.04, tempMin: 12000, tempMax: 24000, size: [0.86, 1.2], brightness: [0.84, 1.1] },
	{ id: 'A', weight: 0.22, tempMin: 7600, tempMax: 9800, size: [0.7, 1.02], brightness: [0.56, 0.9] },
	{ id: 'F', weight: 0.4, tempMin: 6200, tempMax: 7400, size: [0.58, 0.9], brightness: [0.38, 0.72] },
	{ id: 'G', weight: 0.2, tempMin: 5300, tempMax: 6000, size: [0.5, 0.82], brightness: [0.28, 0.6] },
	{ id: 'K', weight: 0.14, tempMin: 3900, tempMax: 5100, size: [0.44, 0.74], brightness: [0.18, 0.42] },
]);

const GIANT_CLASSES = normalizeWeights([
	{ id: 'G', weight: 0.12, tempMin: 5000, tempMax: 5800, size: [1.2, 1.8], brightness: [0.86, 1.18] },
	{ id: 'K', weight: 0.54, tempMin: 3900, tempMax: 5000, size: [1.26, 2.0], brightness: [0.92, 1.28] },
	{ id: 'M', weight: 0.28, tempMin: 3000, tempMax: 3900, size: [1.38, 2.2], brightness: [0.98, 1.36] },
	{ id: 'A', weight: 0.06, tempMin: 8000, tempMax: 9600, size: [1.08, 1.5], brightness: [0.82, 1.06] },
]);

export function mountStarfield(canvas, options = {}) {
	if (!canvas) return () => {};

	const ctx = canvas.getContext('2d', { alpha: false });
	if (!ctx) return () => {};

	const getSize = typeof options.getSize === 'function'
		? options.getSize
		: () => ({
			width: window.innerWidth || canvas.clientWidth || 0,
			height: window.innerHeight || canvas.clientHeight || 0,
		});
	const observeTarget = options.observeTarget || null;
	const motionQuery = typeof window.matchMedia === 'function'
		? window.matchMedia(REDUCED_MOTION)
		: null;

	const state = {
		width: 0,
		height: 0,
		centerX: 0,
		centerY: 0,
		dpr: 1,
		starCount: 0,
		spawnMargin: 160,
		cameraShiftX: 0,
		cameraShiftY: 0,
		cameraAngle: 0,
		driftX: 2.8,
		driftY: 0.95,
		rotationRate: 0.00036,
		sky: null,
		stars: [],
		meteors: [],
		nextMeteorAt: 0,
		frameId: 0,
		running: false,
		lastTime: performance.now(),
		reducedMotion: Boolean(motionQuery?.matches),
		baseSky: '#1E2326',
	};
	let resizeObserver = null;

	function applyMotionPreference() {
		state.reducedMotion = Boolean(motionQuery?.matches);
		state.meteors = [];
		scheduleNextMeteor(state, performance.now());
	}

	function resize() {
		const nextSize = getSize() || {};
		const width = Math.max(1, Math.round(nextSize.width || canvas.clientWidth || window.innerWidth || 0));
		const height = Math.max(1, Math.round(nextSize.height || canvas.clientHeight || window.innerHeight || 0));

		state.width = width;
		state.height = height;
		state.centerX = width * 0.5;
		state.centerY = height * 0.5;
		state.dpr = Math.min(window.devicePixelRatio || 1, 2);
		state.spawnMargin = Math.max(120, Math.hypot(width, height) * 0.16);
		state.starCount = clamp(Math.round(width * height * 0.00022), 90, 520);
		state.baseSky = resolveBaseSky(canvas);

		canvas.width = Math.round(width * state.dpr);
		canvas.height = Math.round(height * state.dpr);
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

		rebuildScene();
		draw(performance.now() * 0.001);
	}

	function rebuildScene() {
		state.cameraShiftX = 0;
		state.cameraShiftY = 0;
		state.cameraAngle = 0;
		state.sky = createSkyModel(state);
		state.stars = Array.from({ length: state.starCount }, () => createStar(state));
		state.meteors = [];
		scheduleNextMeteor(state, performance.now());
	}

	function tick(now) {
		if (!state.running) return;

		const dt = Math.min((now - state.lastTime) * 0.001, 0.04);
		state.lastTime = now;

		if (!state.reducedMotion) {
			state.cameraShiftX += state.driftX * dt;
			state.cameraShiftY += state.driftY * dt;
			state.cameraAngle += state.rotationRate * dt;
			maybeSpawnMeteor(state, now);
		}

		updateMeteors(state, now);
		draw(now * 0.001);
		state.frameId = requestAnimationFrame(tick);
	}

	function start() {
		if (state.running) return;
		state.running = true;
		state.lastTime = performance.now();
		state.frameId = requestAnimationFrame(tick);
	}

	function stop() {
		state.running = false;
		cancelAnimationFrame(state.frameId);
		state.frameId = 0;
	}

	function handleVisibility() {
		if (document.hidden) {
			stop();
			return;
		}

		draw(performance.now() * 0.001);
		start();
	}

	window.addEventListener('resize', resize);
	if (observeTarget && typeof ResizeObserver === 'function') {
		resizeObserver = new ResizeObserver(() => resize());
		resizeObserver.observe(observeTarget);
	}
	document.addEventListener('visibilitychange', handleVisibility);

	if (motionQuery) {
		if (typeof motionQuery.addEventListener === 'function') {
			motionQuery.addEventListener('change', applyMotionPreference);
		} else if (typeof motionQuery.addListener === 'function') {
			motionQuery.addListener(applyMotionPreference);
		}
	}

	applyMotionPreference();
	resize();
	if (!document.hidden) start();

	return () => {
		stop();
		window.removeEventListener('resize', resize);
		resizeObserver?.disconnect();
		document.removeEventListener('visibilitychange', handleVisibility);

		if (motionQuery) {
			if (typeof motionQuery.removeEventListener === 'function') {
				motionQuery.removeEventListener('change', applyMotionPreference);
			} else if (typeof motionQuery.removeListener === 'function') {
				motionQuery.removeListener(applyMotionPreference);
			}
		}
	};

	function draw(seconds) {
		drawBaseSky(ctx, state);
		drawDeepSky(ctx, state, seconds);
		drawStars(ctx, state, seconds);
		drawMeteors(ctx, state, seconds);
	}
}

function createSkyModel(state) {
	const span = Math.hypot(state.width, state.height) * 1.4;
	const bandAngle = -0.54 + (Math.random() - 0.5) * 0.18;
	const bandOffset = (Math.random() - 0.5) * span * 0.08;
	const bandWidth = span * 0.16;

	const clusters = [];
	const clusterCount = 4 + Math.floor(Math.random() * 3);

	for (let i = 0; i < clusterCount; i += 1) {
		const along = randomRange(-span * 0.45, span * 0.45);
		const perpendicular = randomRange(-bandWidth * 0.55, bandWidth * 0.55);
		const x = along * Math.cos(bandAngle) - perpendicular * Math.sin(bandAngle);
		const y = along * Math.sin(bandAngle) + perpendicular * Math.cos(bandAngle);
		const cool = Math.random() > 0.55;

		clusters.push({
			x,
			y,
			radius: randomRange(span * 0.055, span * 0.11),
			intensity: randomRange(0.12, 0.28),
			phase: Math.random() * TWO_PI,
			color: cool
				? { r: 108, g: 140, b: 214 }
				: { r: 182, g: 158, b: 122 },
		});
	}

	return {
		span,
		bandAngle,
		bandOffset,
		bandWidth,
		clusters,
	};
}

function createStar(state) {
	const screen = sampleScreenPoint(state);

	return makeStarFromScreenPoint(state, screen.x, screen.y);
}

function makeStarFromScreenPoint(state, screenX, screenY) {
	const world = screenToWorld(state, screenX, screenY);
	return buildStar(state, world.x, world.y);
}

function buildStar(state, worldX, worldY) {
	const density = sampleDensity(state.sky, worldX, worldY);
	const giantChance = 0.012 + density.cluster * 0.035;
	const isGiant = Math.random() < giantChance;
	const starClass = isGiant
		? pickWeightedClass(GIANT_CLASSES)
		: pickSpectralClass(density);
	const temperature = randomRange(starClass.tempMin, starClass.tempMax);
	const colorBase = temperatureToRgb(temperature);
	const brightnessSeed = Math.pow(Math.random(), isGiant ? 0.75 : 2.45);
	const localBoost = density.band * 0.12 + density.cluster * 0.26;
	const brightness = clamp(
		lerp(starClass.brightness[0], starClass.brightness[1], 1 - brightnessSeed) + localBoost,
		0.06,
		1.38
	);
	const radius = clamp(
		lerp(starClass.size[0], starClass.size[1], 1 - Math.pow(Math.random(), isGiant ? 0.8 : 1.9))
			+ density.cluster * (isGiant ? 0.15 : 0.07),
		0.26,
		2.5
	);
	const perceivedColor = mixColor(
		STAR_WHITE,
		colorBase,
		clamp((brightness - 0.14) * 1.18, 0.08, isGiant ? 0.96 : 0.82)
	);
	return {
		x: worldX,
		y: worldY,
		classId: starClass.id,
		temperature,
		brightness,
		radius,
		color: perceivedColor,
		twinkleAmplitude: clamp(
			(isGiant ? 0.028 : 0.014)
			+ brightness * 0.045
			+ (radius < 0.9 ? 0.012 : 0)
			+ density.cluster * 0.01,
			0.006,
			0.09
		),
		twinkleSpeed: randomRange(0.7, 1.8),
		phase1: Math.random() * TWO_PI,
		phase2: Math.random() * TWO_PI,
		phase3: Math.random() * TWO_PI,
	};
}

function pickSpectralClass(density) {
	if (density.cluster > 0.12 && Math.random() < density.cluster * 2.1) {
		return pickWeightedClass(CLUSTER_YOUNG_CLASSES);
	}

	if (density.band > 0.45 && Math.random() < 0.08) {
		return pickWeightedClass(CLUSTER_YOUNG_CLASSES);
	}

	return pickWeightedClass(SPECTRAL_CLASSES);
}

function sampleDensity(sky, x, y) {
	const bandPerpendicular = -x * Math.sin(sky.bandAngle) + y * Math.cos(sky.bandAngle) - sky.bandOffset;
	const band = Math.exp(-(bandPerpendicular * bandPerpendicular) / (2 * sky.bandWidth * sky.bandWidth));

	let cluster = 0;

	for (const item of sky.clusters) {
		const dx = x - item.x;
		const dy = y - item.y;
		const dist = Math.hypot(dx, dy);
		const weight = item.intensity * Math.exp(-(dist * dist) / (2 * item.radius * item.radius));
		cluster = Math.max(cluster, weight);
	}

	return {
		band,
		cluster,
		total: clamp(0.16 + band * 0.58 + cluster * 0.74, 0.14, 1),
	};
}

function drawBaseSky(ctx, state) {
	ctx.fillStyle = state.baseSky;
	ctx.fillRect(0, 0, state.width, state.height);
}

function drawDeepSky(ctx, state, seconds) {
	if (!state.sky) return;

	ctx.save();
	ctx.translate(state.centerX + state.cameraShiftX, state.centerY + state.cameraShiftY);
	ctx.rotate(state.cameraAngle);

	ctx.restore();
}

function drawStars(ctx, state, seconds) {
	const cos = Math.cos(state.cameraAngle);
	const sin = Math.sin(state.cameraAngle);
	const meteorMargin = state.spawnMargin * 1.1;

	for (const star of state.stars) {
		let screenX = state.centerX + state.cameraShiftX + star.x * cos - star.y * sin;
		let screenY = state.centerY + state.cameraShiftY + star.x * sin + star.y * cos;

		if (
			screenX < -meteorMargin
			|| screenX > state.width + meteorMargin
			|| screenY < -meteorMargin
			|| screenY > state.height + meteorMargin
		) {
			respawnStar(state, star, cos, sin);
			screenX = state.centerX + state.cameraShiftX + star.x * cos - star.y * sin;
			screenY = state.centerY + state.cameraShiftY + star.x * sin + star.y * cos;
		}

		const horizonFactor = clamp(screenY / state.height, 0, 1);
		const extinction = 1 - horizonFactor * horizonFactor * 0.18;
		const twinkle = state.reducedMotion
			? 0
			: star.twinkleAmplitude
				* (0.16 + horizonFactor * 0.3)
				* (
					Math.sin(seconds * star.twinkleSpeed + star.phase1) * 0.58
					+ Math.sin(seconds * (star.twinkleSpeed * 1.91) + star.phase2) * 0.27
					+ Math.sin(seconds * (star.twinkleSpeed * 3.14) + star.phase3) * 0.15
				);
		const intensity = clamp(star.brightness * extinction * (1 + twinkle), 0.03, 1.55);
		const drawRadius = clamp(star.radius * (1 + twinkle * 0.06), 0.24, 2.7);
		const warmShift = Math.pow(horizonFactor, 1.8) * 0.18;
		const drawColor = mixColor(star.color, HORIZON_WARM, warmShift);

		ctx.fillStyle = rgbaString(drawColor, Math.min(0.98, 0.1 + intensity * 0.88));
		ctx.beginPath();
		ctx.arc(screenX, screenY, drawRadius, 0, TWO_PI);
		ctx.fill();
	}
}

function respawnStar(state, star, cos, sin) {
	const spawn = sampleScreenPoint(state, true);
	const dx = spawn.x - state.centerX - state.cameraShiftX;
	const dy = spawn.y - state.centerY - state.cameraShiftY;
	const worldX = dx * cos + dy * sin;
	const worldY = -dx * sin + dy * cos;
	const next = buildStar(state, worldX, worldY);

	Object.assign(star, next);
}

function sampleScreenPoint(state, fromEdge = false) {
	let bestPoint = null;
	let bestDensity = -1;

	for (let attempt = 0; attempt < 14; attempt += 1) {
		const point = fromEdge
			? chooseSpawnPoint(state)
			: {
				x: randomRange(-state.spawnMargin, state.width + state.spawnMargin),
				y: randomRange(-state.spawnMargin, state.height + state.spawnMargin),
			};
		const world = screenToWorld(state, point.x, point.y);
		const density = sampleDensity(state.sky, world.x, world.y).total;

		if (density > bestDensity) {
			bestDensity = density;
			bestPoint = point;
		}

		if (Math.random() < density) {
			return point;
		}
	}

	return bestPoint || chooseSpawnPoint(state);
}

function chooseSpawnPoint(state) {
	const total = Math.abs(state.driftX) + Math.abs(state.driftY);
	const xBias = total > 0 ? Math.abs(state.driftX) / total : 0.5;

	if (Math.random() < xBias) {
		return {
			x: state.driftX >= 0 ? -state.spawnMargin : state.width + state.spawnMargin,
			y: randomRange(-state.spawnMargin, state.height + state.spawnMargin),
		};
	}

	return {
		x: randomRange(-state.spawnMargin, state.width + state.spawnMargin),
		y: state.driftY >= 0 ? -state.spawnMargin : state.height + state.spawnMargin,
	};
}

function drawMeteors(ctx, state, seconds) {
	for (const meteor of state.meteors) {
		const progress = (seconds - meteor.startSeconds) / meteor.duration;
		if (progress < 0 || progress > 1.12) continue;

		const envelope = Math.sin(clamp(progress, 0, 1) * Math.PI);
		const travel = easeOutCubic(clamp(progress, 0, 1)) * meteor.travel;
		const headX = meteor.startX + meteor.dirX * travel;
		const headY = meteor.startY + meteor.dirY * travel;
		const tailLength = meteor.length * (0.55 + envelope * 0.18);
		const tailX = headX - meteor.dirX * tailLength;
		const tailY = headY - meteor.dirY * tailLength;

		ctx.save();
		ctx.globalCompositeOperation = 'screen';

		const core = ctx.createLinearGradient(tailX, tailY, headX, headY);
		core.addColorStop(0, 'rgba(255, 255, 255, 0)');
		core.addColorStop(0.35, `rgba(206, 222, 255, ${0.12 * envelope})`);
		core.addColorStop(0.8, `rgba(255, 245, 214, ${0.52 * envelope})`);
		core.addColorStop(1, `rgba(255, 252, 244, ${0.8 * envelope})`);
		ctx.strokeStyle = core;
		ctx.lineWidth = meteor.width;
		ctx.lineCap = 'butt';
		ctx.beginPath();
		ctx.moveTo(tailX, tailY);
		ctx.lineTo(headX, headY);
		ctx.stroke();

		ctx.restore();
	}
}

function maybeSpawnMeteor(state, now) {
	if (state.reducedMotion || now < state.nextMeteorAt || state.meteors.length >= 2) {
		return;
	}

	state.meteors.push(createMeteor(state, now * 0.001));
	scheduleNextMeteor(state, now);
}

function updateMeteors(state, now) {
	const seconds = now * 0.001;
	state.meteors = state.meteors.filter((meteor) => seconds - meteor.startSeconds <= meteor.duration * 1.12);
}

function scheduleNextMeteor(state, now) {
	if (state.reducedMotion) {
		state.nextMeteorAt = Number.POSITIVE_INFINITY;
		return;
	}

	state.nextMeteorAt = now + randomRange(28000, 90000);
}

function createMeteor(state, startSeconds) {
	const fromRight = Math.random() > 0.5;
	const angle = fromRight
		? randomRange(Math.PI * 0.62, Math.PI * 0.76)
		: randomRange(Math.PI * 0.24, Math.PI * 0.38);
	const travel = randomRange(Math.hypot(state.width, state.height) * 0.18, Math.hypot(state.width, state.height) * 0.34);
	const speed = randomRange(1100, 1680);

	return {
		startSeconds,
		duration: travel / speed,
		startX: fromRight
			? randomRange(state.width * 0.55, state.width + state.spawnMargin * 0.35)
			: randomRange(-state.spawnMargin * 0.35, state.width * 0.45),
		startY: randomRange(-state.spawnMargin * 0.4, state.height * 0.38),
		dirX: Math.cos(angle),
		dirY: Math.sin(angle),
		travel,
		length: randomRange(34, 82),
		width: randomRange(0.55, 1.05),
	};
}

function screenToWorld(state, x, y) {
	const dx = x - state.centerX - state.cameraShiftX;
	const dy = y - state.centerY - state.cameraShiftY;
	const cos = Math.cos(state.cameraAngle);
	const sin = Math.sin(state.cameraAngle);

	return {
		x: dx * cos + dy * sin,
		y: -dx * sin + dy * cos,
	};
}

function temperatureToRgb(kelvin) {
	const temp = kelvin / 100;
	let red = 255;
	let green;
	let blue;

	if (temp <= 66) {
		green = 99.4708025861 * Math.log(temp) - 161.1195681661;
		blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
	} else {
		red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
		green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
		blue = 255;
	}

	return {
		r: clamp(Math.round(red), 0, 255),
		g: clamp(Math.round(green), 0, 255),
		b: clamp(Math.round(blue), 0, 255),
	};
}

function resolveBaseSky(canvas) {
	const styles = getComputedStyle(canvas);
	const custom = styles.getPropertyValue('--login-sky-bg').trim();
	return custom || '#1E2326';
}

function normalizeWeights(items) {
	const total = items.reduce((sum, item) => sum + item.weight, 0);
	let cursor = 0;

	return items.map((item) => {
		cursor += item.weight / total;
		return {
			...item,
			threshold: cursor,
		};
	});
}

function pickWeightedClass(items) {
	const roll = Math.random();
	return items.find((item) => roll <= item.threshold) || items[items.length - 1];
}

function mixColor(a, b, t) {
	return {
		r: Math.round(lerp(a.r, b.r, t)),
		g: Math.round(lerp(a.g, b.g, t)),
		b: Math.round(lerp(a.b, b.b, t)),
	};
}

function rgbaString(color, alpha) {
	return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(alpha, 0, 1)})`;
}

function gaussian(mean, deviation) {
	let u = 0;
	let v = 0;

	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();

	return mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v) * deviation;
}

function randomRange(min, max) {
	return min + Math.random() * (max - min);
}

function easeOutCubic(t) {
	return 1 - Math.pow(1 - t, 3);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
	return a + (b - a) * t;
}
