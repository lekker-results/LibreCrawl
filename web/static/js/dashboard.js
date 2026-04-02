// ========================================
// Client Entity Tabs & Dashboard Functions
// ========================================

window.activeClient = null;
window.activeEntities = [];    // [{type, id, domain, name, crawls}, ...]
window.activeEntityIndex = -1; // Which entity tab is selected
let _clientsCache = null;

// ── Welcome Page ─────────────────────────────────────────────────

async function showWelcomePage() {
    document.querySelector('.app-container').classList.add('welcome-mode');

    const listEl = document.getElementById('welcomeClientsList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="welcome-empty">Loading clients...</div>';

    try {
        const resp = await fetch('/api/clients');
        const data = await resp.json();
        if (!data.success || !data.clients || data.clients.length === 0) {
            listEl.innerHTML = `<div class="welcome-empty">
                <p>No clients yet. Create your first client to get started.</p>
                <button class="btn btn-secondary" onclick="seedDemoData()" style="margin-top:12px;">Load Demo Data</button>
            </div>`;
            return;
        }

        const cards = data.clients.map(c => {
            const name = escapeHtml(c.name);
            const domain = escapeHtml(c.domain || '—');
            const crawlCount = c.crawl_count || 0;
            const lastCrawl = c.last_crawl_at ? new Date(c.last_crawl_at).toLocaleDateString() : 'Never';
            const initial = c.name.charAt(0).toUpperCase();
            return `<div class="welcome-client-card" onclick="selectClient(${c.id}, '${name.replace(/'/g, "\\'")}')">
                <div class="welcome-client-header">
                    <div class="welcome-client-avatar">${initial}</div>
                    <div class="welcome-client-info">
                        <span class="welcome-client-name">${name}</span>
                        <span class="welcome-client-domain">${domain}</span>
                    </div>
                </div>
                <div class="welcome-client-footer">
                    <span>${crawlCount} crawl${crawlCount !== 1 ? 's' : ''}</span>
                    <span>Last: ${lastCrawl}</span>
                </div>
            </div>`;
        });
        listEl.innerHTML = cards.join('');
    } catch (e) {
        console.error('Error loading welcome page clients:', e);
        listEl.innerHTML = '<div class="welcome-empty" style="color:var(--status-error);">Error loading clients</div>';
    }
}

// ── Phase 7: Pipeline badge enhancement for welcome page ──────────
// Runs after the original showWelcomePage completes to append pipeline
// and portal data to each client card. Non-destructive — original
// card markup is preserved.

const _originalShowWelcomePage = showWelcomePage;
showWelcomePage = async function() {
    await _originalShowWelcomePage();

    // Fetch pipeline summary (best-effort — fail silently)
    let pipelineByClientId = {};
    try {
        const resp = await fetch('/api/pipeline');
        const data = await resp.json();
        if (data.success && data.clients) {
            data.clients.forEach(c => {
                pipelineByClientId[c.client_id] = c;
            });
        }
    } catch (e) {
        return;
    }

    if (Object.keys(pipelineByClientId).length === 0) return;

    // Patch each card to add pipeline badge
    document.querySelectorAll('#welcomeClientsList .welcome-client-card').forEach(card => {
        const onclickAttr = card.getAttribute('onclick') || '';
        const match = onclickAttr.match(/selectClient\((\d+)/);
        if (!match) return;
        const clientId = parseInt(match[1], 10);
        const pipeline = pipelineByClientId[clientId];
        if (!pipeline) return;

        const phase      = pipeline.client_phase || '';
        const stageName  = pipeline.stage_name || '';
        const daysInStage = pipeline.days_in_stage || 0;
        const pc         = pipeline.portal_completion || {};
        const total      = pc.total || 0;
        const completed  = pc.completed || 0;
        const overdue    = pc.overdue || 0;

        const footer = card.querySelector('.welcome-client-footer');
        if (!footer) return;

        const badgeRow = document.createElement('div');
        badgeRow.className = 'welcome-pipeline-row';
        badgeRow.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
        badgeRow.innerHTML = `
            <span class="pipeline-phase-badge" data-phase="${escapeHtml(phase)}">${escapeHtml(phase)}: ${escapeHtml(stageName)}</span>
            ${total > 0 ? `<span class="portal-completion-indicator">${completed}/${total}</span>` : ''}
            ${overdue > 0 ? `<span class="portal-overdue-badge">${overdue} overdue</span>` : ''}
            <span class="pipeline-days-indicator">${daysInStage}d</span>
        `;
        card.insertBefore(badgeRow, footer);
    });
};

function hideWelcomePage() {
    document.querySelector('.app-container').classList.remove('welcome-mode');
}

function filterWelcomeGrid(query) {
    const q = (query || '').toLowerCase().trim();
    document.querySelectorAll('#welcomeClientsList .welcome-client-card').forEach(card => {
        card.style.display = (!q || card.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
}

async function seedDemoData() {
    showLoading('Creating demo data...', 'Setting up Acme Corp with crawl data');
    try {
        const resp = await fetch('/api/seed-demo-data', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            showNotification('Demo data created!', 'success');
            loadClientsDropdown();
            await showWelcomePage();
            if (data.client_id) {
                await selectClient(data.client_id, 'Acme Corp');
            }
        } else {
            showNotification(data.error || 'Failed to create demo data', 'error');
        }
    } catch (e) {
        showNotification('Error creating demo data', 'error');
    } finally {
        hideLoading();
    }
}

// ── Clients Search Dropdown ───────────────────────────────────────

async function loadClientsDropdown() {
    try {
        const response = await fetch('/api/clients');
        const data = await response.json();
        if (!data.success) return;
        _clientsCache = data.clients || [];
        renderClientsDropdown(_clientsCache);
    } catch (e) {
        console.error('Error loading clients:', e);
    }
}

function renderClientsDropdown(clients) {
    const list = document.getElementById('clientsDropdownList');
    if (!list) return;
    if (!clients.length) {
        list.innerHTML = '<div class="clients-dropdown-item clients-dropdown-empty">No clients yet</div>';
        return;
    }
    list.innerHTML = clients.map(c => {
        const nameEsc = escapeHtml(c.name);
        const domainEsc = escapeHtml(c.domain || '');
        const domainHtml = c.domain ? `<span class="clients-dropdown-domain">${domainEsc}</span>` : '';
        return `<div class="clients-dropdown-item client-item" data-name="${nameEsc.toLowerCase()}" data-domain="${domainEsc.toLowerCase()}" onclick="selectClient(${c.id}, '${nameEsc.replace(/'/g, "\\'")}')">${nameEsc}${domainHtml}</div>`;
    }).join('');
}

function openClientsResults() {
    document.getElementById('clientsDropdownMenu').classList.add('open');
    loadClientsDropdown();
    setTimeout(() => document.addEventListener('mousedown', _closeSearchOutside), 0);
}

function closeClientsResults() {
    document.getElementById('clientsDropdownMenu').classList.remove('open');
    document.removeEventListener('mousedown', _closeSearchOutside);
}

function _closeSearchOutside(e) {
    const wrapper = document.getElementById('clientsDropdown');
    if (!wrapper.contains(e.target)) closeClientsResults();
}

function filterClients(query) {
    const items = document.querySelectorAll('#clientsDropdownList .client-item');
    const q = query.toLowerCase().trim();
    items.forEach(item => {
        const name = item.getAttribute('data-name') || '';
        const domain = item.getAttribute('data-domain') || '';
        item.classList.toggle('hidden', q && !name.includes(q) && !domain.includes(q));
    });
    document.getElementById('clientsDropdownMenu').classList.add('open');
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Client Selection & Entity Tabs ────────────────────────────────

async function selectClient(clientId, clientName) {
    hideWelcomePage();
    document.getElementById('clientSearchInput').value = clientName;
    closeClientsResults();

    showLoading('Loading client...');
    try {
        const resp = await fetch(`/api/clients/${clientId}`);
        const data = await resp.json();
        if (!data.success) {
            hideLoading();
            showNotification(data.error || 'Failed to load client', 'error');
            return;
        }

        window.activeClient = {
            ...data.client,
            crawls: data.crawls,
            entities: data.entities,
            offpage: data.offpage,
        };

        // Build entity list: client first, then entities (competitors/branches)
        window.activeEntities = [];

        // Client entity
        window.activeEntities.push({
            type: 'client',
            id: data.client.id,
            domain: data.client.domain || '',
            name: data.client.name,
            crawls: data.crawls.client || [],
            _cache: null,
        });

        // Competitor/branch entities
        for (const ent of (data.entities || [])) {
            window.activeEntities.push({
                type: ent.type || 'competitor',
                id: ent.id,
                domain: ent.domain,
                name: ent.name || ent.domain,
                crawls: ent.crawls || [],
                _cache: null,
            });
        }

        document.getElementById('crawlTypeWrapper').style.display = 'flex';
        renderEntityTabs();
        // Auto-select client tab
        await switchEntity(0);

        // Phase 7: show pipeline status strip
        updateClientPipelineStrip(clientId);
    } catch (e) {
        console.error('Error loading client:', e);
        showNotification('Error loading client', 'error');
    } finally {
        hideLoading();
    }
}

async function updateClientPipelineStrip(clientId) {
    const strip = document.getElementById('client-pipeline-status');
    if (!strip) return;
    try {
        const resp = await fetch(`/api/clients/${clientId}/pipeline`);
        const data = await resp.json();
        if (!data.success || !data.current) {
            strip.style.display = 'none';
            return;
        }
        const c = data.current;
        const phase     = c.client_phase || '';
        const stageName = c.stage_name || '';
        const stage     = c.stage || '';
        const daysInStage = c.stage_entered_at
            ? Math.floor((Date.now() - new Date(c.stage_entered_at)) / 86400000)
            : 0;

        let portalSummary = '';
        try {
            const presp = await fetch(`/api/clients/${clientId}/portal`);
            const pdata = await presp.json();
            if (pdata.success && pdata.portal && pdata.portal.checklist) {
                const ch = pdata.portal.checklist;
                portalSummary = `
                    <span class="client-pipeline-portal">
                        Portal: ${ch.completed}/${ch.total} items
                        ${ch.overdue > 0 ? `<span class="portal-overdue-badge">(${ch.overdue} overdue)</span>` : ''}
                    </span>
                `;
            }
        } catch (e) { /* portal data unavailable */ }

        strip.innerHTML = `
            <span class="pipeline-phase-badge" data-phase="${escapeHtml(phase)}">
                Stage ${stage} — ${escapeHtml(stageName)}
            </span>
            <span class="client-pipeline-days">${daysInStage}d in stage</span>
            ${portalSummary}
        `;
        strip.style.display = 'flex';
    } catch (e) {
        strip.style.display = 'none';
    }
}

function deselectClient() {
    window.activeClient = null;
    window.activeEntities = [];
    window.activeEntityIndex = -1;
    document.getElementById('entityTabBar').style.display = 'none';
    document.getElementById('crawlTypeWrapper').style.display = 'none';
    const _strip = document.getElementById('client-pipeline-status');
    if (_strip) _strip.style.display = 'none';
    crawlState.clientId = null;
    crawlState.crawlType = 'standalone';
    crawlState.entityId = null;
    document.getElementById('clientSearchInput').value = '';
    document.getElementById('urlInput').value = '';
    clearCrawlData();
    showWelcomePage();
}

function syncCrawlTypeSelect(type) {
    const sel = document.getElementById('crawlTypeSelect');
    if (sel) sel.value = type || 'client';
}

function onCrawlTypeChange(value) {
    crawlState.crawlType = value;
    if (window.activeEntityIndex >= 0 && window.activeEntities[window.activeEntityIndex]) {
        window.activeEntities[window.activeEntityIndex].type = value;
        renderEntityTabs();
    }
}

// ── Render Entity Tabs ────────────────────────────────────────────

function renderEntityTabs() {
    const bar = document.getElementById('entityTabBar');
    const list = document.getElementById('entityTabList');

    let html = '';
    window.activeEntities.forEach((entity, i) => {
        const isActive = i === window.activeEntityIndex;
        const isComp = entity.type === 'competitor';
        const isBranch = entity.type === 'branch';
        const icon = isComp ? '<span class="entity-tab-icon entity-tab-icon--comp">&#9670;</span>' : (isBranch ? '<span class="entity-tab-icon entity-tab-icon--branch">&#9679;</span>' : '');
        const label = escapeHtml(entity.name || entity.domain);
        html += `<button class="entity-tab${isActive ? ' active' : ''}${isComp ? ' competitor' : ''}${isBranch ? ' branch' : ''}" onclick="switchEntity(${i})" ondblclick="startTabRename(${i}, event)" title="${escapeHtml(entity.domain || entity.name)}">${icon}${label}<span class="entity-tab-delete" onclick="deleteEntityTab(${i}, event)" title="Delete crawl data">\u00d7</span></button>`;
    });

    list.innerHTML = html;
    bar.style.display = 'flex';
}

function startTabRename(index, event) {
    event.stopPropagation();
    const tabs = document.querySelectorAll('.entity-tab');
    const tab = tabs[index];
    if (!tab) return;
    const currentName = window.activeEntities[index].name || window.activeEntities[index].domain;
    tab.innerHTML = `<input class="tab-rename-input" value="${escapeHtml(currentName)}" onclick="event.stopPropagation()">`;
    const input = tab.querySelector('.tab-rename-input');
    input.select();
    let committed = false;
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); committed = true; commitTabRename(index, input.value); }
        if (e.key === 'Escape') { committed = true; renderEntityTabs(); }
    });
    input.addEventListener('blur', () => { if (!committed) commitTabRename(index, input.value); });
}

function commitTabRename(index, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) { renderEntityTabs(); return; }
    window.activeEntities[index].name = trimmed;
    window.activeEntities[index]._overriddenName = true;
    renderEntityTabs();
}

async function deleteEntityTab(index, event) {
    event.stopPropagation();

    const entity = window.activeEntities[index];
    const entityName = entity.name || entity.domain;
    const crawlIds = (entity.crawls || []).map(c => c.id).filter(Boolean);

    if (!confirm(`Delete all crawl data for "${entityName}"?\n\nThis cannot be undone.`)) return;

    for (const crawlId of crawlIds) {
        await fetch(`/api/crawls/${crawlId}/delete`, { method: 'DELETE' });
    }

    if ((entity.type === 'competitor' || entity.type === 'branch') && entity.id && window.activeClient) {
        await fetch(`/api/clients/${window.activeClient.id}/entities/${entity.id}`, { method: 'DELETE' });
    }

    window.activeEntities.splice(index, 1);

    if (window.activeEntities.length === 0) {
        deselectClient();
        return;
    }

    if (window.activeEntityIndex >= window.activeEntities.length) {
        window.activeEntityIndex = window.activeEntities.length - 1;
    }

    renderEntityTabs();
    await switchEntity(window.activeEntityIndex);
    updateStatus(`Deleted crawl data for "${entityName}"`);
}

function extractBusinessNameFromUrls(urls) {
    if (!urls || !urls.length) return null;
    const home = urls.find(u => u.depth === 0) || urls[0];
    if (!home) return null;
    for (const schema of (home.json_ld || [])) {
        const t = schema['@type'] || '';
        if (/Organization|LocalBusiness|Corporation|WebSite/i.test(t) && schema.name) {
            return schema.name.trim();
        }
    }
    const og = home.og_tags || {};
    const siteName = og.site_name || og['og:site_name'];
    if (siteName) return siteName.trim();
    const title = (home.title || '').trim();
    if (title) {
        const cleaned = title.split(/\s+[|\-–›\/]\s+/)[0].trim();
        if (cleaned && cleaned.length < 60) return cleaned;
    }
    const h1 = (home.h1 || '').trim();
    if (h1 && h1.length < 60) return h1;
    return null;
}

window.updateEntityTabNameFromCrawl = function(urls) {
    if (window.activeEntityIndex < 0 || !window.activeEntities) return;
    const entity = window.activeEntities[window.activeEntityIndex];
    if (!entity || entity._overriddenName) return;
    const name = extractBusinessNameFromUrls(urls);
    if (name) {
        entity.name = name;
        renderEntityTabs();
    }
};

async function switchEntity(index) {
    if (index < 0 || index >= window.activeEntities.length) return;
    window.activeEntityIndex = index;
    const entity = window.activeEntities[index];

    // Update tab active states
    document.querySelectorAll('.entity-tab').forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
    });

    // Update URL input
    document.getElementById('urlInput').value = entity.domain || '';

    // Set crawl state context
    crawlState.clientId = window.activeClient.id;
    if (entity.type === 'competitor' || entity.type === 'branch') {
        crawlState.crawlType = entity.type;
        crawlState.entityId = entity.id;
    } else {
        crawlState.crawlType = 'client';
        crawlState.entityId = null;
    }
    syncCrawlTypeSelect(crawlState.crawlType);

    // Load the latest crawl for this entity
    const crawls = entity.crawls || [];
    if (crawls.length > 0) {
        const targetCrawlId = crawls[0].id;
        if (entity._cache && entity._cache.crawlId === targetCrawlId) {
            await restoreFromEntityCache(index, entity._cache);
        } else {
            const loadedData = await loadCrawlFromContext(targetCrawlId);
            if (loadedData) window.activeEntities[index]._cache = loadedData;
        }
    } else {
        // No crawls — clear data and show empty state
        clearCrawlData();
        if (entity.domain) {
            document.getElementById('urlInput').value = entity.domain;
        }
        // Keep client context
        crawlState.clientId = window.activeClient.id;
        crawlState.crawlType = (entity.type === 'competitor' || entity.type === 'branch') ? entity.type : 'client';
        crawlState.entityId = (entity.type === 'competitor' || entity.type === 'branch') ? entity.id : null;
        syncCrawlTypeSelect(crawlState.crawlType);
    }
}

async function restoreFromEntityCache(index, cache) {
    clearAllTables();
    resetStats();
    crawlState.urls = [];
    crawlState.links = cache.links || [];
    crawlState.issues = cache.issues || [];
    crawlState.stats = cache.stats || {};
    crawlState.baseUrl = cache.baseUrl || '';
    crawlState.loadedCrawlId = cache.crawlId;
    if (cache.baseUrl) document.getElementById('urlInput').value = cache.baseUrl;
    (cache.urls || []).forEach(url => addUrlToTable(url));
    if (cache.links?.length) crawlState.pendingLinks = cache.links;
    if (cache.issues?.length) crawlState.pendingIssues = cache.issues;
    updateStatsDisplay();
    updateFilterCounts();
    updateStatusCodesTable();
    updateCrawlButtons();
    updateStatus(`Loaded: ${(cache.urls || []).length} URLs`);
    if (typeof window.updateVisualizationFromLoadedData === 'function') {
        window.updateVisualizationFromLoadedData(cache.urls || [], cache.links || []);
    }
    if (window.LibreCrawlPlugin?.loader) {
        window.LibreCrawlPlugin.loader.notifyDataUpdate({
            urls: crawlState.urls, links: crawlState.links,
            issues: crawlState.issues, stats: crawlState.stats
        });
    }
    // Silently update server session in background (for exports)
    fetch(`/api/crawls/${cache.crawlId}/load`, { method: 'POST' }).catch(() => {});
}

// ── Add Competitor From Tab Bar ───────────────────────────────────

function showAddEntityModal() {
    document.getElementById('addEntityDomain').value = '';
    document.getElementById('addEntityName').value = '';
    document.getElementById('addEntityType').value = 'competitor';
    document.getElementById('addEntityModal').style.display = 'flex';
    setTimeout(() => document.getElementById('addEntityDomain').focus(), 50);
}

function hideAddEntityModal() {
    document.getElementById('addEntityModal').style.display = 'none';
}

async function submitAddEntityModal() {
    const domain = document.getElementById('addEntityDomain').value.trim();
    const name = document.getElementById('addEntityName').value.trim() || null;
    const type = document.getElementById('addEntityType').value;
    const autoCrawl = document.getElementById('addEntityAutoCrawl').checked;
    if (!domain || !window.activeClient) { document.getElementById('addEntityDomain').focus(); return; }
    try {
        const resp = await fetch(`/api/clients/${window.activeClient.id}/entities`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, name, type }),
        });
        const data = await resp.json();
        if (data.success) {
            hideAddEntityModal();
            // Optimistically add entity — no server roundtrip needed before switching
            window.activeEntities.push({
                type,
                id: data.entity_id,
                domain,
                name: name || domain,
                crawls: [],
                _cache: null,
            });
            const newIndex = window.activeEntities.length - 1;
            renderEntityTabs();
            await switchEntity(newIndex);
            if (autoCrawl) startCrawl();
            showNotification('Entity added', 'success');
        } else {
            showNotification(data.error || 'Failed to add entity', 'error');
        }
    } catch (e) {
        showNotification('Error adding entity', 'error');
    }
}

// ── Refresh Client Data ───────────────────────────────────────────

async function refreshActiveClient() {
    if (!window.activeClient) return;
    try {
        const resp = await fetch(`/api/clients/${window.activeClient.id}`);
        const data = await resp.json();
        if (data.success) {
            window.activeClient = {
                ...data.client,
                crawls: data.crawls,
                entities: data.entities,
                offpage: data.offpage,
            };
            // Rebuild entities
            window.activeEntities = [];
            window.activeEntities.push({
                type: 'client',
                id: data.client.id,
                domain: data.client.domain || '',
                name: data.client.name,
                crawls: data.crawls.client || [],
                _cache: null,
            });
            for (const ent of (data.entities || [])) {
                window.activeEntities.push({
                    type: ent.type || 'competitor',
                    id: ent.id,
                    domain: ent.domain,
                    name: ent.name || ent.domain,
                    crawls: ent.crawls || [],
                    _cache: null,
                });
            }
        }
    } catch (e) {
        console.error('Error refreshing client:', e);
    }
}

// ── New Client Modal ───────────────────────────────────────────────

function openNewClientForm() { showAddClientModal(); }

function showAddClientModal() {
    document.getElementById('addClientDomain').value = '';
    document.getElementById('addClientName').value = '';
    document.getElementById('addClientAutoCrawl').checked = true;
    document.getElementById('addClientModal').style.display = 'flex';
    setTimeout(() => document.getElementById('addClientDomain').focus(), 50);
}

function hideAddClientModal() {
    document.getElementById('addClientModal').style.display = 'none';
}

async function submitAddClientModal() {
    const domain = document.getElementById('addClientDomain').value.trim();
    const inputName = document.getElementById('addClientName').value.trim();
    const autoCrawl = document.getElementById('addClientAutoCrawl').checked;
    if (!domain) { document.getElementById('addClientDomain').focus(); return; }
    const name = inputName || domain;
    try {
        const resp = await fetch('/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, domain }),
        });
        const data = await resp.json();
        if (data.success) {
            hideAddClientModal();
            loadClientsDropdown();
            await selectClient(data.client_id, name);
            if (autoCrawl) startCrawl();
            showNotification('Client created', 'success');
        } else {
            showNotification(data.error || 'Failed to create client', 'error');
        }
    } catch (e) {
        showNotification('Error creating client', 'error');
    }
}

// ── Edit Client Modal ──────────────────────────────────────────────

function openEditClientModal() {
    if (!window.activeClient) return;
    document.getElementById('editClientModalBody').innerHTML = _buildClientFormFields(window.activeClient);
    document.getElementById('editClientModal').style.display = 'flex';
}

function hideEditClientModal() {
    document.getElementById('editClientModal').style.display = 'none';
}

function _buildClientFormFields(client) {
    const v = (field) => escapeHtml((client && client[field]) || '');
    return `
        <div class="setting-group">
            <label class="setting-label">Client Name <span style="color:#f87171">*</span></label>
            <input type="text" id="clientFormName" class="setting-input" value="${v('name')}" placeholder="e.g. Acme Corp">
        </div>
        <div class="setting-group">
            <label class="setting-label">Domain</label>
            <input type="text" id="clientFormDomain" class="setting-input" value="${v('domain')}" placeholder="e.g. acmecorp.com">
        </div>
        <div class="setting-group">
            <label class="setting-label">Business Name</label>
            <input type="text" id="clientFormBusinessName" class="setting-input" value="${v('business_name')}" placeholder="For GBP lookup (defaults to client name)">
        </div>
        <div class="setting-group">
            <label class="setting-label">Location</label>
            <input type="text" id="clientFormLocation" class="setting-input" value="${v('location')}" placeholder="e.g. Chicago, IL">
        </div>
        <div class="setting-group">
            <label class="setting-label">Phone</label>
            <input type="text" id="clientFormPhone" class="setting-input" value="${v('phone')}" placeholder="e.g. +1 555-123-4567">
        </div>
        <div class="setting-group">
            <label class="setting-label">Address</label>
            <input type="text" id="clientFormAddress" class="setting-input" value="${v('address')}" placeholder="Street address for NAP audits">
        </div>
        <div class="setting-group">
            <label class="setting-label">Notes</label>
            <textarea id="clientFormNotes" class="setting-input" placeholder="Internal notes">${v('notes')}</textarea>
        </div>
        <div style="display:flex;gap:8px;margin-top:20px;">
            <button class="btn btn-primary" onclick="submitEditClientModal(${client.id})">Save</button>
            <button class="btn btn-secondary" onclick="hideEditClientModal()">Cancel</button>
        </div>
    `;
}

async function submitEditClientModal(clientId) {
    const formData = _getClientFormData();
    if (!formData.name) { showNotification('Client name is required', 'error'); return; }
    try {
        const resp = await fetch(`/api/clients/${clientId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData),
        });
        const data = await resp.json();
        if (data.success) {
            showNotification('Client updated', 'success');
            hideEditClientModal();
            loadClientsDropdown();
            await refreshActiveClient();
            renderEntityTabs();
        } else {
            showNotification(data.error || 'Failed to update client', 'error');
        }
    } catch (e) {
        showNotification('Error updating client', 'error');
    }
}

// ── Client Form (inline pane — kept for legacy paths) ──────────────

function openNewClientFormFull() {
    closeClientsResults();
    hideWelcomePage();
    document.getElementById('clientSearchInput').value = '';

    const panes = document.querySelectorAll('.tab-pane');
    panes.forEach(p => p.classList.remove('active'));

    let formPane = document.getElementById('client-form-pane');
    if (!formPane) {
        formPane = document.createElement('div');
        formPane.id = 'client-form-pane';
        formPane.className = 'tab-pane';
        document.querySelector('.tab-content').appendChild(formPane);
    }
    formPane.classList.add('active');
    formPane.innerHTML = _buildClientForm();
}

function openEditClientForm() {
    if (!window.activeClient) return;
    const panes = document.querySelectorAll('.tab-pane');
    panes.forEach(p => p.classList.remove('active'));

    let formPane = document.getElementById('client-form-pane');
    if (!formPane) {
        formPane = document.createElement('div');
        formPane.id = 'client-form-pane';
        formPane.className = 'tab-pane';
        document.querySelector('.tab-content').appendChild(formPane);
    }
    formPane.classList.add('active');
    formPane.innerHTML = _buildClientForm(window.activeClient);
}

function _buildClientForm(client = null) {
    const isEdit = !!client;
    const v = (field) => escapeHtml((client && client[field]) || '');
    return `
        <div class="client-form" style="padding:24px;">
            <h2 style="color:var(--text-primary);margin:0 0 20px;">${isEdit ? 'Edit Client' : 'New Client'}</h2>
            <div class="form-group">
                <label>Client Name *</label>
                <input type="text" id="clientFormName" value="${v('name')}" placeholder="e.g. Acme Corp">
            </div>
            <div class="form-group">
                <label>Domain</label>
                <input type="text" id="clientFormDomain" value="${v('domain')}" placeholder="e.g. acmecorp.com">
                <div class="form-hint">Leave empty if client has no website</div>
            </div>
            <div class="form-group">
                <label>Business Name</label>
                <input type="text" id="clientFormBusinessName" value="${v('business_name')}" placeholder="Name for GBP lookup (defaults to client name)">
            </div>
            <div class="form-group">
                <label>Location</label>
                <input type="text" id="clientFormLocation" value="${v('location')}" placeholder="e.g. Chicago, IL">
            </div>
            <div class="form-group">
                <label>Phone</label>
                <input type="text" id="clientFormPhone" value="${v('phone')}" placeholder="e.g. +1 555-123-4567">
            </div>
            <div class="form-group">
                <label>Address</label>
                <input type="text" id="clientFormAddress" value="${v('address')}" placeholder="Street address for NAP audits">
            </div>
            <div class="form-group">
                <label>Notes</label>
                <textarea id="clientFormNotes" placeholder="Internal notes">${v('notes')}</textarea>
            </div>
            <div style="display:flex;gap:10px;margin-top:18px;">
                <button class="btn btn-primary" onclick="${isEdit ? `submitEditClient(${client.id})` : 'submitNewClient()'}">${isEdit ? 'Save Changes' : 'Create Client'}</button>
                <button class="btn btn-secondary" onclick="cancelClientForm()">Cancel</button>
            </div>
        </div>
    `;
}

function cancelClientForm() {
    const formPane = document.getElementById('client-form-pane');
    if (formPane) formPane.classList.remove('active');
    if (!window.activeClient) {
        showWelcomePage();
    } else {
        switchTab('overview');
    }
}

function _getClientFormData() {
    return {
        name: document.getElementById('clientFormName').value.trim(),
        domain: document.getElementById('clientFormDomain').value.trim() || null,
        business_name: document.getElementById('clientFormBusinessName').value.trim() || null,
        location: document.getElementById('clientFormLocation').value.trim() || null,
        phone: document.getElementById('clientFormPhone').value.trim() || null,
        address: document.getElementById('clientFormAddress').value.trim() || null,
        notes: document.getElementById('clientFormNotes').value.trim() || null,
    };
}

async function submitNewClient() {
    const formData = _getClientFormData();
    if (!formData.name) { showNotification('Client name is required', 'error'); return; }

    try {
        const resp = await fetch('/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData),
        });
        const data = await resp.json();
        if (data.success) {
            showNotification('Client created', 'success');
            loadClientsDropdown();
            // Close form directly — cancelClientForm() would call showWelcomePage()
            // since window.activeClient is still null here, causing a flicker/broken state
            const formPane = document.getElementById('client-form-pane');
            if (formPane) formPane.classList.remove('active');
            await selectClient(data.client_id, formData.name);
        } else {
            showNotification(data.error || 'Failed to create client', 'error');
        }
    } catch (e) {
        showNotification('Error creating client', 'error');
    }
}

async function submitEditClient(clientId) {
    const formData = _getClientFormData();
    if (!formData.name) { showNotification('Client name is required', 'error'); return; }

    try {
        const resp = await fetch(`/api/clients/${clientId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData),
        });
        const data = await resp.json();
        if (data.success) {
            showNotification('Client updated', 'success');
            loadClientsDropdown();
            await refreshActiveClient();
            renderEntityTabs();
            cancelClientForm();
        } else {
            showNotification(data.error || 'Failed to update client', 'error');
        }
    } catch (e) {
        showNotification('Error updating client', 'error');
    }
}

// ── Crawl Loading ─────────────────────────────────────────────────

async function loadCrawlFromContext(crawlId) {
    const hasUnsavedData = crawlState.isRunning || (crawlState.urls.length > 0 && !crawlState.loadedCrawlId);
    if (hasUnsavedData && !confirm('Load this crawl? Any unsaved current data will be lost.')) return;

    showLoading('Loading crawl data...', 'This may take a moment for large crawls');
    try {
        const response = await fetch(`/api/crawls/${crawlId}/load`, { method: 'POST' });
        const data = await response.json();
        if (!data.success) {
            showNotification('Error: ' + (data.error || data.message), 'error');
            return;
        }

        const statusResponse = await fetch('/api/crawl_status');
        const statusData = await statusResponse.json();

        clearAllTables();
        resetStats();

        crawlState.urls = [];
        crawlState.links = statusData.links || [];
        crawlState.issues = statusData.issues || [];
        crawlState.stats = statusData.stats || {};
        crawlState.baseUrl = statusData.stats?.baseUrl || '';
        crawlState.loadedCrawlId = crawlId;

        if (crawlState.baseUrl) {
            document.getElementById('urlInput').value = crawlState.baseUrl;
        }

        if (statusData.urls && statusData.urls.length > 0) {
            statusData.urls.forEach(url => addUrlToTable(url));
        }
        if (statusData.links && statusData.links.length > 0) {
            crawlState.pendingLinks = statusData.links;
        }
        if (statusData.issues && statusData.issues.length > 0) {
            crawlState.pendingIssues = statusData.issues;
        }

        updateStatsDisplay();
        updateFilterCounts();
        updateStatusCodesTable();
        updateCrawlButtons();
        updateStatus(`Loaded: ${statusData.urls?.length || 0} URLs`);

        if (typeof window.updateVisualizationFromLoadedData === 'function') {
            window.updateVisualizationFromLoadedData(statusData.urls || [], statusData.links || []);
        }
        if (window.LibreCrawlPlugin && window.LibreCrawlPlugin.loader) {
            window.LibreCrawlPlugin.loader.notifyDataUpdate({
                urls: crawlState.urls,
                links: crawlState.links,
                issues: crawlState.issues,
                stats: crawlState.stats
            });
        }

        showNotification('Crawl loaded', 'success');
        return {
            crawlId,
            urls: statusData.urls || [],
            links: statusData.links || [],
            issues: statusData.issues || [],
            stats: statusData.stats || {},
            baseUrl: crawlState.baseUrl,
        };
    } catch (error) {
        console.error('Error loading crawl:', error);
        showNotification('Error loading crawl', 'error');
    } finally {
        hideLoading();
    }
}

// Backward compat alias
async function loadCrawlFromDashboard(crawlId) {
    return loadCrawlFromContext(crawlId);
}

// ── Start Crawl (entity-aware) ────────────────────────────────────

function startClientCrawl(clientId, domain, crawlType, entityId) {
    const urlInput = document.getElementById('urlInput');
    urlInput.value = domain;
    crawlState.clientId = clientId;
    crawlState.crawlType = crawlType;
    crawlState.entityId = entityId || null;
    startCrawl();
}

// Load clients dropdown and show welcome page on init
document.addEventListener('DOMContentLoaded', function() {
    loadClientsDropdown();
    if (!window.activeClient) {
        showWelcomePage();
    }
});
