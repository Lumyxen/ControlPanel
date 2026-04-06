// Model Manager – search & download from HuggingFace
// Called from app.js after the settings fragment is loaded.

export function initModelManager(root) {
    const searchInput  = root.querySelector('#hf-search-input');
    const searchBtn    = root.querySelector('#hf-search-btn');
    const statusDiv    = root.querySelector('#hf-search-status');
    const resultsList  = root.querySelector('#hf-results-list');
    const sortSelect   = root.querySelector('#hf-sort-select');
    const filterImage  = root.querySelector('#hf-filter-image');
    const filterAudio  = root.querySelector('#hf-filter-audio');
    const localList    = root.querySelector('#hf-local-models-list');

    if (!searchInput || !searchBtn) return;

    /* ── helpers ─────────────────────────────────────────── */

    function showStatus(msg, type) {
        if (type === void 0) type = 'info';
        var bgMap = {
            info:    'var(--badge-info-bg, #2563eb)',
            success: 'var(--badge-success-bg, #16a34a)',
            error:   'var(--badge-error-bg, #dc2626)',
            warning: 'var(--badge-warning-bg, #d97706)'
        };
        var bg = bgMap[type] || bgMap.info;
        statusDiv.innerHTML =
            '<span class="badge" style="display:inline-block;margin-top:4px;">' + msg + '</span>';
    }

    /* ── search ──────────────────────────────────────────── */

    async function searchModels() {
        var query = searchInput.value.trim();
        if (!query) { showStatus('Enter a search query', 'warning'); return; }

        showStatus('Searching\u2026', 'info');
        resultsList.innerHTML = '<div style="text-align:center;padding:1rem;font-size:0.85rem;color:var(--muted);">Searching\u2026</div>';

        try {
            var params = new URLSearchParams({ search: query, limit: '20', sort: sortSelect.value });
            if (filterImage.checked) params.append('image_support', '1');
            if (filterAudio.checked)  params.append('audio_support', '1');

            var res  = await fetch('/api/huggingface/search?' + params.toString());
            var data = await res.json();

            if (data.error) {
                showStatus('Error: ' + data.error, 'error');
                resultsList.innerHTML = '';
                return;
            }
            if (!data.data || data.data.length === 0) {
                showStatus('No models found', 'warning');
                resultsList.innerHTML = '';
                return;
            }

            showStatus('Found ' + data.total + ' model(s)', 'success');
            renderResults(data.data);
        } catch (err) {
            showStatus('Search failed: ' + err.message, 'error');
            resultsList.innerHTML = '';
        }
    }

    function renderResults(models) {
        resultsList.innerHTML = '';
        models.forEach(function(m) {
            var hasVision = m.has_image_support || (m.tags && (m.tags.indexOf('vision') >= 0 || m.tags.indexOf('llava') >= 0));
            var hasAudio  = m.has_audio_support;
            var badges = '';
            if (hasVision) badges += '<span class="badge" style="color:var(--ctp-purple);border-color:var(--ctp-purple);">Vision</span> ';
            if (hasAudio)  badges += '<span class="badge" style="color:var(--ctp-teal);border-color:var(--ctp-teal);">Audio</span> ';
            badges += '<span class="badge">GGUF</span>';

            var card = document.createElement('div');
            card.style.cssText = 'border:1px solid var(--border);background:color-mix(in srgb,var(--panel) 85%,transparent);padding:12px;display:grid;gap:6px;';

            card.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">' +
                    '<div style="flex:1;min-width:0;">' +
                        '<div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.name + '</div>' +
                        '<div style="margin-bottom:4px;">' + badges + '</div>' +
                        '<div style="display:flex;gap:0.75rem;font-size:0.78rem;color:var(--muted);">' +
                            '<span>' + (m.downloads || 0).toLocaleString() + ' downloads</span>' +
                            '<span>' + (m.likes || 0).toLocaleString() + ' likes</span>' +
                            (m.pipeline_tag ? '<span>' + m.pipeline_tag + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div id="dl-area-' + m.id.replace(/[^a-zA-Z0-9]/g, '_') + '" style="display:flex;gap:4px;flex-shrink:0;">' +
                        '<button class="btn" data-hf-download="' + m.id + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>' +
                    '</div>' +
                '</div>';

            resultsList.appendChild(card);
        });
    }

    /* ── quantisation picker + download ──────────────────── */

    async function showQuantPicker(modelId, btn) {
        var orig = btn.textContent;
        btn.textContent = 'Loading\u2026';
        btn.disabled = true;

        try {
            var res = await fetch('/api/huggingface/files?model_id=' + encodeURIComponent(modelId));
            var data = await res.json();

            if (data.error || !data.gguf || !data.gguf.length) {
                showStatus('No GGUF files found', 'warning');
                btn.textContent = orig;
                btn.disabled = false;
                return;
            }

            // Build picker HTML
            var area = btn.parentElement;
            area.innerHTML = '';

            var wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

            var select = document.createElement('select');
            select.className = 'text-input';
            select.style.cssText = 'width:auto;min-width:140px;font-size:0.85rem;padding:5px 8px;';

            // Sort: prefer K_M, then K_S, then others
            var order = ['Q4_K_M','Q4_K_S','Q5_K_M','Q5_K_S','Q4_0','Q3_K_M','Q6_K','Q8_0','IQ4_XS','IQ4_NL','Q2_K','IQ3_M','IQ3_S'];
            var sorted = data.gguf.slice().sort(function(a, b) {
                var ai = -1, bi = -1;
                for (var i = 0; i < order.length; i++) {
                    if (a.name.indexOf(order[i]) >= 0) ai = i;
                    if (b.name.indexOf(order[i]) >= 0) bi = i;
                }
                return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
            });

            sorted.forEach(function(f, idx) {
                var opt = document.createElement('option');
                opt.value = f.path;
                opt.textContent = f.name;
                if (idx === 0) opt.selected = true;
                select.appendChild(opt);
            });

            var dlBtn = document.createElement('button');
            dlBtn.className = 'btn';
            dlBtn.textContent = 'Download';
            dlBtn.style.cssText = 'font-size:0.85rem;padding:6px 12px;';

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'font-size:0.85rem;padding:6px 12px;';
            cancelBtn.addEventListener('click', function() {
                area.innerHTML = '<button class="btn" data-hf-download="' + modelId + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>';
            });

            dlBtn.addEventListener('click', function() {
                var filePath = select.value;
                // Build directory name: provider/modelName-quant
                var slashPos = modelId.indexOf('/');
                var provider = slashPos >= 0 ? modelId.substring(0, slashPos) : 'unknown';
                var modelName = slashPos >= 0 ? modelId.substring(slashPos + 1) : modelId;

                // Extract quant from filename
                var ggufName = filePath.split('/').pop();
                var quants = ['Q4_K_M','Q4_K_S','Q5_K_M','Q5_K_S','Q4_0','Q3_K_M','Q6_K','Q8_0',
                              'IQ4_XS','IQ4_NL','IQ3_M','IQ3_S','Q2_K','IQ2_M','IQ2_XS','IQ2_S',
                              'Q4_AWQ','FP16','FP32'];
                for (var i = 0; i < quants.length; i++) {
                    if (ggufName.indexOf(quants[i]) >= 0) {
                        modelName += '-' + quants[i];
                        break;
                    }
                }
                var dirName = provider + '/' + modelName;

                // Also get mmproj and tokenizer for this model
                var mmprojPath = '', tokenizerPath = '';
                if (data.mmproj && data.mmproj.length) mmprojPath = data.mmproj[0].path;
                if (data.tokenizer && data.tokenizer.length) tokenizerPath = data.tokenizer[0].path;

                area.innerHTML = '';
                startDownload(modelId, dirName, filePath, mmprojPath, tokenizerPath, area);
            });

            wrapper.appendChild(select);
            wrapper.appendChild(dlBtn);
            wrapper.appendChild(cancelBtn);
            area.appendChild(wrapper);

        } catch (err) {
            showStatus('Failed to list files: ' + err.message, 'error');
            btn.textContent = orig;
            btn.disabled = false;
        }
    }

    function startDownload(modelId, dirName, ggufPath, mmprojPath, tokenizerPath, area) {
        showStatus('Starting download of ' + modelId + '\u2026', 'info');

        fetch('/api/huggingface/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_id: modelId,
                directory_name: dirName,
                gguf_path: ggufPath,
                mmproj_path: mmprojPath,
                tokenizer_path: tokenizerPath
            })
        }).then(function(r) { return r.json(); }).then(function(result) {
            if (result.status !== 'started') {
                showStatus('Download failed: ' + (result.error || 'Unknown error'), 'error');
                area.innerHTML = '<button class="btn" data-hf-download="' + modelId + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>';
                return;
            }

            var jobId = result.job_id;
            var statusEl = document.createElement('span');
            statusEl.style.cssText = 'font-size:0.85rem;color:var(--muted);padding:0 8px;';
            statusEl.textContent = '0%';
            area.appendChild(statusEl);

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'font-size:0.85rem;padding:6px 12px;';
            cancelBtn.addEventListener('click', function() {
                fetch('/api/huggingface/cancel-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_id: jobId })
                });
            });
            area.appendChild(cancelBtn);

            // Poll progress
            var pollTimer = setInterval(function() {
                fetch('/api/huggingface/download-status?job_id=' + encodeURIComponent(jobId))
                    .then(function(r) { return r.json(); })
                    .then(function(st) {
                        if (st.status === 'completed') {
                            clearInterval(pollTimer);
                            showStatus('Downloaded \u2192 ' + st.directory_name, 'success');
                            area.innerHTML = '<button class="btn" data-hf-download="' + modelId + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>';
                            loadLocalModels();
                        } else if (st.status === 'failed') {
                            clearInterval(pollTimer);
                            showStatus('Download failed: ' + (st.error || 'Unknown error'), 'error');
                            area.innerHTML = '<button class="btn" data-hf-download="' + modelId + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>';
                        } else {
                            var pct = Math.round(st.percent || 0);
                            statusEl.textContent = (st.current_file ? st.current_file + ' ' : '') + pct + '%';
                        }
                    }).catch(function() {});
            }, 500);
        }).catch(function(err) {
            showStatus('Download failed: ' + err.message, 'error');
            area.innerHTML = '<button class="btn" data-hf-download="' + modelId + '" style="font-size:0.85rem;padding:6px 12px;">Download</button>';
        });
    }

    /* ── event delegation for download buttons ───────────── */

    resultsList.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-hf-download]');
        if (!btn) return;
        showQuantPicker(btn.dataset.hfDownload, btn);
    });

    /* ── delete local model ──────────────────────────────── */

    async function deleteModel(modelId, btn) {
        if (!confirm('Delete "' + modelId + '"?\nThis will permanently remove the model files.')) return;

        var orig = btn.textContent;
        btn.textContent = 'Deleting\u2026';
        btn.disabled = true;

        try {
            var res = await fetch('/api/models', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_id: modelId })
            });
            var result = await res.json();

            if (result.status === 'deleted') {
                showStatus('Deleted ' + modelId, 'success');
                loadLocalModels();
            } else if (result.status === 'not_found') {
                showStatus('Model not found', 'warning');
                loadLocalModels();
            } else {
                showStatus('Delete failed: ' + (result.error || 'Unknown error'), 'error');
                btn.textContent = orig;
                btn.disabled = false;
            }
        } catch (err) {
            showStatus('Delete failed: ' + err.message, 'error');
            btn.textContent = orig;
            btn.disabled = false;
        }
    }

    /* ── install tokenizer ─────────────────────────────────── */

    async function installTokenizer(modelId, btn) {
        var dirName = '';
        if (modelId.startsWith('llamacpp::')) {
            dirName = modelId.substring(10);
        }

        var orig = btn.textContent;
        btn.textContent = 'Installing\u2026';
        btn.disabled = true;
        showStatus('Installing tokenizer for ' + modelId + '\u2026', 'info');

        try {
            var res = await fetch('/api/huggingface/install-tokenizer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_id: modelId, directory_name: dirName })
            });
            var result = await res.json();

            if (result.status === 'installed') {
                showStatus('Tokenizer installed (' + result.files_downloaded + ' file(s))', 'success');
                loadLocalModels();
            } else {
                showStatus('Tokenizer install failed: ' + (result.error || 'Unknown error'), 'error');
                btn.textContent = orig;
                btn.disabled = false;
            }
        } catch (err) {
            showStatus('Tokenizer install failed: ' + err.message, 'error');
            btn.textContent = orig;
            btn.disabled = false;
        }
    }

    localList.addEventListener('click', function(e) {
        var delBtn = e.target.closest('[data-delete-model]');
        if (delBtn) {
            deleteModel(delBtn.dataset.deleteModel, delBtn);
            return;
        }
        var tokBtn = e.target.closest('[data-install-tokenizer]');
        if (tokBtn) {
            installTokenizer(tokBtn.dataset.installTokenizer, tokBtn);
            return;
        }
    });

    /* ── local models ────────────────────────────────────── */

    async function loadLocalModels() {
        try {
            var res  = await fetch('/api/models');
            var data = await res.json();
            var llm  = (data.data || []).filter(function(m) { return m.source === 'llamacpp'; });

            if (!llm.length) {
                localList.innerHTML = '<div style="text-align:center;padding:1rem;font-size:0.85rem;color:var(--muted);">No local models</div>';
                return;
            }

            localList.innerHTML = '';
            llm.forEach(function(m) {
                var badges = '';
                if (m.has_tokenizer) badges += '<span class="badge" style="color:var(--ctp-green);border-color:var(--ctp-green);">Tokenizer</span> ';
                if (m.has_mmproj)   badges += '<span class="badge" style="color:var(--ctp-yellow);border-color:var(--ctp-yellow);">Vision</span> ';
                if (m.loaded)       badges += '<span class="badge badge-success">Loaded</span> ';

                var card = document.createElement('div');
                card.style.cssText = 'border:1px solid var(--border);background:color-mix(in srgb,var(--panel) 85%,transparent);padding:12px;display:grid;gap:6px;';

                var actionBtns = '';
                if (!m.has_tokenizer) {
                    actionBtns += '<button class="btn" data-install-tokenizer="' + m.id + '" style="font-size:0.75rem;padding:2px 8px;">Install Tokenizer</button>';
                }
                actionBtns += '<button class="btn btn-danger-sm" data-delete-model="' + m.id + '" style="font-size:0.75rem;padding:2px 8px;">Delete</button>';

                card.innerHTML =
                    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                        '<div>' +
                            '<div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;">' + m.name + '</div>' +
                            '<div style="margin-bottom:2px;">' + badges + '</div>' +
                            '<div style="font-size:0.78rem;color:var(--muted);">Context: ' + (m.context_length || 'N/A').toLocaleString() + ' tokens</div>' +
                        '</div>' +
                        '<div style="display:flex;gap:6px;align-items:center;">' +
                            '<span class="badge" style="font-family:ui-monospace,monospace;">' + m.id + '</span>' +
                            actionBtns +
                        '</div>' +
                    '</div>';
                localList.appendChild(card);
            });
        } catch (err) {
            localList.innerHTML = '<div style="text-align:center;padding:1rem;font-size:0.85rem;color:var(--muted);">Failed to load</div>';
        }
    }

    /* ── wire up events ──────────────────────────────────── */

    searchBtn.addEventListener('click', searchModels);
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') searchModels();
    });

    // initial load
    loadLocalModels();
}
