// www/js/chat/token-highlighting.js
// Wraps rendered text nodes into token spans with logprob-based styling.

const LOGPROB_UNCERTAIN_THRESHOLD = -1.0;   // < 50 %  → red
const LOGPROB_MODERATE_THRESHOLD    = -0.32; // 50-80 % → yellow
const TOKEN_TOOLTIP_ID = 'token-logprob-tooltip';

export function logprobToProbability(logprob) {
    return Math.pow(2, logprob) * 100;
}

function getHighlightClass(logprob, settings) {
    if (logprob == null || isNaN(logprob)) return null;
    const showHigh   = settings?.logprobHighlightHigh ?? false;
    const showMedium = settings?.logprobHighlightMedium ?? false;
    const showLow    = settings?.logprobHighlightLow ?? true;
    if (logprob >= LOGPROB_MODERATE_THRESHOLD) {
        if (showHigh) return 'token-certain';
        return null;
    }
    if (logprob >= LOGPROB_UNCERTAIN_THRESHOLD) {
        if (showMedium) return 'token-moderate';
        return null;
    }
    if (showLow) return 'token-uncertain';
    return null;
}

function getTooltip(logprob) {
    if (logprob == null || isNaN(logprob)) return '';
    return `${Math.round(logprobToProbability(logprob))}%`;
}

export function isFormattingOnlyTextContent(text) {
    return typeof text === 'string' && text.trim() === '' && /[\r\n\t]/.test(text);
}

function collectTextNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
        if (isFormattingOnlyTextContent(n.textContent)) continue;
        out.push(n);
    }
    return out;
}

function getOrCreateTooltipEl() {
    if (typeof document === 'undefined') return null;
    let tooltipEl = document.getElementById(TOKEN_TOOLTIP_ID);
    if (tooltipEl) return tooltipEl;

    tooltipEl = document.createElement('div');
    tooltipEl.id = TOKEN_TOOLTIP_ID;
    tooltipEl.className = 'token-logprob-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function hideGlobalTooltip() {
    const tooltipEl = getOrCreateTooltipEl();
    if (!tooltipEl) return;
    tooltipEl.classList.remove('is-visible');
    tooltipEl.textContent = '';
}

function positionGlobalTooltip(tooltipEl, tokenEl) {
    const tokenRect = tokenEl.getBoundingClientRect();
    const viewportMargin = 8;
    const tooltipGap = 8;

    tooltipEl.style.left = '0px';
    tooltipEl.style.top = '0px';

    const tooltipRect = tooltipEl.getBoundingClientRect();
    let left = tokenRect.left + (tokenRect.width / 2) - (tooltipRect.width / 2);
    left = Math.max(viewportMargin, Math.min(left, window.innerWidth - tooltipRect.width - viewportMargin));

    let top = tokenRect.top - tooltipRect.height - tooltipGap;
    if (top < viewportMargin) {
        top = tokenRect.bottom + tooltipGap;
    }
    if (top + tooltipRect.height > window.innerHeight - viewportMargin) {
        top = Math.max(viewportMargin, window.innerHeight - tooltipRect.height - viewportMargin);
    }

    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
}

function showGlobalTooltip(tokenEl) {
    const tooltip = tokenEl?.getAttribute('data-probability');
    if (!tooltip) {
        hideGlobalTooltip();
        return;
    }

    const tooltipEl = getOrCreateTooltipEl();
    if (!tooltipEl) return;

    tooltipEl.textContent = tooltip;
    tooltipEl.classList.add('is-visible');
    positionGlobalTooltip(tooltipEl, tokenEl);
}

function bindViewportTooltipLifecycle() {
    if (typeof window === 'undefined' || window.__tokenTooltipViewportBound) return;
    const hide = () => hideGlobalTooltip();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.__tokenTooltipViewportBound = true;
}

function bindContentTooltipLifecycle(contentEl) {
    if (!contentEl || contentEl.dataset.tokenTooltipBound === 'true') return;

    contentEl.addEventListener('pointerover', (event) => {
        const tokenEl = event.target instanceof Element
            ? event.target.closest('.token[data-probability]')
            : null;
        if (!tokenEl || !contentEl.contains(tokenEl)) {
            hideGlobalTooltip();
            return;
        }
        showGlobalTooltip(tokenEl);
    });

    contentEl.addEventListener('pointerout', (event) => {
        const nextToken = event.relatedTarget instanceof Element
            ? event.relatedTarget.closest('.token[data-probability]')
            : null;
        if (nextToken && contentEl.contains(nextToken)) return;
        hideGlobalTooltip();
    });

    contentEl.addEventListener('scroll', () => hideGlobalTooltip(), true);
    contentEl.dataset.tokenTooltipBound = 'true';
}

function unwrapTokenHighlighting(contentEl) {
    const tokens = [...contentEl.querySelectorAll('.token')].reverse();
    for (const token of tokens) {
        token.replaceWith(...token.childNodes);
    }
}

export function mapDomTextToTokenLogprobs(domText, tokenLogprobs) {
    const tokenText = tokenLogprobs.map((t) => t.text).join('');
    const tokenCharLogprobs = [];
    for (const token of tokenLogprobs) {
        for (let i = 0; i < token.text.length; i++) {
            tokenCharLogprobs.push(token.logprob);
        }
    }

    const domToTokenLogprob = new Array(domText.length).fill(null);
    let tokIdx = 0;
    let matched = 0;

    for (let domIdx = 0; domIdx < domText.length; domIdx++) {
        const domCh = domText[domIdx];

        while (tokIdx < tokenText.length && tokenText[tokIdx] !== domCh) {
            tokIdx++;
        }

        if (tokIdx < tokenText.length && tokenText[tokIdx] === domCh) {
            domToTokenLogprob[domIdx] = tokenCharLogprobs[tokIdx] ?? null;
            matched++;
            tokIdx++;
        }
    }

    return { domToTokenLogprob, matched, tokenText };
}

export function applyTokenHighlighting(contentEl, tokenLogprobs, settings) {
    if (!contentEl || !tokenLogprobs?.length) return;

    contentEl.classList.add('token-highlighting-enabled');
    bindViewportTooltipLifecycle();
    bindContentTooltipLifecycle(contentEl);
    // The streaming completion path may re-run highlighting on already-wrapped
    // content. Unwrap first so repeated calls stay layout-stable and idempotent.
    unwrapTokenHighlighting(contentEl);

    const textNodes = collectTextNodes(contentEl);
    if (!textNodes.length) return;

    const domText = textNodes.map(n => n.textContent).join('');
    const { domToTokenLogprob, matched } = mapDomTextToTokenLogprobs(domText, tokenLogprobs);
    if (matched === 0) return;

    // Build character map
    const charMap = [];
    let c = 0;
    for (const tn of textNodes) {
        for (let i = 0; i < tn.textContent.length; i++) {
            charMap.push({ node: tn, offset: i });
            c++;
        }
    }

    // Collect all ranges first, then wrap from end to start
    // Whitespace is never included in ranges, and ranges split at whitespace
    const ranges = [];
    let i = 0;
    while (i < domToTokenLogprob.length) {
        // Skip all whitespace - never highlight it
        if (/\s/.test(domText[i])) {
            i++;
            continue;
        }
        
        const lp = domToTokenLogprob[i];
        const cls = getHighlightClass(lp, settings);
        const tooltip = cls ? getTooltip(lp) : '';

        if (cls) {
            let end = i;
            // Extend range: same logprob AND non-whitespace only
            while (end + 1 < domToTokenLogprob.length && 
                   domToTokenLogprob[end + 1] === lp && 
                   !/\s/.test(domText[end + 1])) {
                end++;
            }
            
            ranges.push({ start: i, end, cls, tooltip, lp });
            i = end + 1;
        } else {
            i++;
        }
    }

    // Wrap from end to start
    let successRanges = 0;
    for (let r = ranges.length - 1; r >= 0; r--) {
        const { start, end, cls, tooltip, lp } = ranges[r];
        if (_wrapRange(charMap, start, end, cls, tooltip, lp)) successRanges++;
    }
}

function _wrapRange(charMap, start, end, cls, tooltip, logprob) {
    if (start >= charMap.length || end >= charMap.length) return false;

    const startSeg = charMap[start];
    const endSeg = charMap[end];
    if (!startSeg || !endSeg) return false;

    if (startSeg.node === endSeg.node) {
        try {
            const range = document.createRange();
            range.setStart(startSeg.node, startSeg.offset);
            range.setEnd(endSeg.node, endSeg.offset + 1);

            const span = document.createElement('span');
            span.className = 'token';
            if (cls) span.classList.add(cls);
            if (tooltip) span.setAttribute('data-probability', tooltip);
            if (logprob != null) span.setAttribute('data-logprob', logprob.toFixed(4));

            range.surroundContents(span);
            return true;
        } catch (_) { return false; }
    } else {
        const nodeRanges = new Map();
        for (let c = start; c <= end; c++) {
            const seg = charMap[c];
            if (!nodeRanges.has(seg.node)) nodeRanges.set(seg.node, [seg.offset, seg.offset]);
            const [rS, rE] = nodeRanges.get(seg.node);
            nodeRanges.set(seg.node, [rS, seg.offset]);
        }
        let nodeWrapped = 0;
        for (const [node, [rS, rE]] of [...nodeRanges.entries()].reverse()) {
            try {
                const range = document.createRange();
                range.setStart(node, rS);
                range.setEnd(node, rE + 1);

                const span = document.createElement('span');
                span.className = 'token';
                if (cls) span.classList.add(cls);
                if (tooltip) span.setAttribute('data-probability', tooltip);
                if (logprob != null) span.setAttribute('data-logprob', logprob.toFixed(4));

                range.surroundContents(span);
                nodeWrapped++;
            } catch (_) { /* skip */ }
        }
        return nodeWrapped > 0;
    }
}
