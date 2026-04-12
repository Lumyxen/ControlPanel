// www/js/chat/token-highlighting.js
// Wraps rendered text nodes into token spans with logprob-based styling.

const LOGPROB_UNCERTAIN_THRESHOLD = -1.0;   // < 50 %  → red
const LOGPROB_MODERATE_THRESHOLD    = -0.32; // 50-80 % → yellow

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

function collectTextNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
}

export function applyTokenHighlighting(contentEl, tokenLogprobs, settings) {
    if (!contentEl || !tokenLogprobs?.length) return;

    contentEl.classList.add('token-highlighting-enabled');

    const textNodes = collectTextNodes(contentEl);
    if (!textNodes.length) return;

    const domText = textNodes.map(n => n.textContent).join('');
    const tokenText = tokenLogprobs.map(t => t.text).join('');

    // Build parallel arrays
    const domToTokenLogprob = new Array(domText.length).fill(null);
    let tokIdx = 0;
    let matched = 0;

    for (let domIdx = 0; domIdx < domText.length; domIdx++) {
        const domCh = domText[domIdx];

        while (tokIdx < tokenText.length && tokenText[tokIdx] !== domCh) {
            tokIdx++;
        }

        if (tokIdx < tokenText.length && tokenText[tokIdx] === domCh) {
            // Find the logprob for this token character
            let lp = null;
            let tp = 0;
            for (const t of tokenLogprobs) {
                if (tp <= tokIdx && tokIdx < tp + t.text.length) {
                    lp = t.logprob;
                    break;
                }
                tp += t.text.length;
            }
            domToTokenLogprob[domIdx] = lp;
            matched++;
            tokIdx++;
        }
    }

    // Forward fill
    let lastKnown = null;
    for (let i = 0; i < domToTokenLogprob.length; i++) {
        if (domToTokenLogprob[i] != null) lastKnown = domToTokenLogprob[i];
        else if (lastKnown != null) domToTokenLogprob[i] = lastKnown;
    }
    // Backward fill
    for (let i = domToTokenLogprob.length - 1; i >= 0; i--) {
        if (domToTokenLogprob[i] != null) break;
        if (lastKnown != null) domToTokenLogprob[i] = lastKnown;
    }

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
        const tooltip = getTooltip(lp);

        if (cls || tooltip) {
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
