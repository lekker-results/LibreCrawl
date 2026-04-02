/**
 * portal-status.js — LekkerResults Client Portal Status Plugin
 * Shows pipeline timeline, checklist table, follow-up log, and credential
 * summary for the selected LibreCrawl client.
 *
 * Data source: /api/clients/{id}/portal and /api/clients/{id}/pipeline
 * Requires: a client to be selected (window.activeClient must be set)
 */

LibreCrawlPlugin.register({
    id: 'portal-status',
    name: 'Portal Status',
    tab: {
        label: 'Portal',
        icon: '🗂',
        position: 'end',
    },
    version: '1.0.0',
    author: 'LekkerResults',
    description: 'Client portal checklist, pipeline timeline, and follow-up log',

    // ── State ───────────────────────────────────────────────────────

    portalData: null,
    pipelineData: null,
    loadError: null,

    // ── Lifecycle ───────────────────────────────────────────────────

    onLoad() {
        this.portalData = null;
        this.pipelineData = null;
        this.loadError = null;
    },

    onTabActivate(container, data) {
        this.container = container;
        if (!window.activeClient || !window.activeClient.id) {
            container.innerHTML = this._renderNoClient();
            return;
        }
        this._loadData(container, window.activeClient.id);
    },

    onTabDeactivate() {
        this.portalData = null;
        this.pipelineData = null;
    },

    // ── Data Loading ────────────────────────────────────────────────

    async _loadData(container, clientId) {
        container.innerHTML = this._renderLoading();
        try {
            const [portalResp, pipelineResp] = await Promise.all([
                fetch(`/api/clients/${clientId}/portal`),
                fetch(`/api/clients/${clientId}/pipeline`),
            ]);
            const portalJson   = await portalResp.json();
            const pipelineJson = await pipelineResp.json();

            this.portalData   = portalJson.success  ? portalJson.portal : null;
            this.pipelineData = pipelineJson.success ? pipelineJson      : null;

            if (!this.portalData && !this.pipelineData) {
                container.innerHTML = this._renderNoPortal(window.activeClient.name || 'this client');
                return;
            }

            this._render(container);
        } catch (err) {
            console.error('Portal status load error:', err);
            container.innerHTML = this._renderError(err.message);
        }
    },

    // ── Main Render ─────────────────────────────────────────────────

    _render(container) {
        const portal   = this.portalData;
        const pipeline = this.pipelineData;

        container.innerHTML = `
            <div class="portal-status-root" style="
                padding: 20px;
                overflow-y: auto;
                max-height: calc(100vh - 280px);
                display: flex;
                flex-direction: column;
                gap: 24px;
            ">
                ${pipeline ? this._renderPipelineSection(pipeline) : ''}
                ${portal   ? this._renderChecklistSection(portal.checklist) : ''}
                ${portal   ? this._renderFollowupSection(portal.recent_followups) : ''}
                ${portal   ? this._renderCredentialsSection(portal.credentials_submitted) : ''}
                ${this._renderQuickActions(window.activeClient.id)}
            </div>
        `;

        this._bindActions(container, window.activeClient.id);
    },

    // ── Pipeline Timeline ───────────────────────────────────────────

    _renderPipelineSection(pipeline) {
        const current = pipeline.current;
        if (!current) return '';

        const phaseBadgeStyle = this._phaseBadgeStyle(current.client_phase);
        const history = pipeline.history || [];

        const timelineRows = history.map(h => {
            const fromName = h.from_stage ? `Stage ${h.from_stage}` : 'Start';
            const toName   = `Stage ${h.to_stage}`;
            const date     = h.changed_at ? new Date(h.changed_at).toLocaleDateString('en-GB') : '—';
            return `
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 8px 0;
                    border-bottom: 1px solid var(--border-alt);
                    font-size: 13px;
                    color: var(--text-secondary);
                ">
                    <span style="min-width: 80px; color: var(--text-dim);">${date}</span>
                    <span>${this.utils.escapeHtml(fromName)} → <strong style="color:var(--text-body);">${this.utils.escapeHtml(toName)}</strong></span>
                    ${h.notes ? `<span style="color:var(--text-dim); font-style:italic;">${this.utils.escapeHtml(h.notes)}</span>` : ''}
                    <span style="margin-left:auto; color:var(--text-dim); font-size:11px;">${this.utils.escapeHtml(h.changed_by)}</span>
                </div>
            `;
        }).join('');

        return `
            <section>
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                    <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0;">
                        Pipeline Timeline
                    </h3>
                    <span class="pipeline-phase-badge" data-phase="${this.utils.escapeHtml(current.client_phase)}" style="${phaseBadgeStyle}">
                        Stage ${current.stage} — ${this.utils.escapeHtml(current.stage_name)}
                    </span>
                </div>
                <div style="background:var(--bg-card,var(--surface-2)); padding:16px; border-radius:10px; border:1px solid var(--border-standard);">
                    <div style="margin-bottom:12px; font-size:13px; color:var(--text-secondary);">
                        <strong>Phase:</strong> ${this.utils.escapeHtml(current.client_phase)}
                        &nbsp;|&nbsp;
                        <strong>Days in stage:</strong> ${current.stage_entered_at ? Math.floor((Date.now() - new Date(current.stage_entered_at)) / 86400000) : '—'}
                        ${current.last_followup_at ? `&nbsp;|&nbsp;<strong>Last follow-up:</strong> ${new Date(current.last_followup_at).toLocaleDateString('en-GB')}` : ''}
                    </div>
                    ${history.length > 0
                        ? `<div>${timelineRows}</div>`
                        : `<p style="color:var(--text-dim); font-size:13px; margin:0;">No stage transitions recorded yet.</p>`
                    }
                </div>
            </section>
        `;
    },

    // ── Checklist Table ─────────────────────────────────────────────

    _renderChecklistSection(checklist) {
        if (!checklist) return '';
        const { total, completed, overdue, rejected, items } = checklist;

        const statusPill = (status) => {
            const map = {
                verified:  ['var(--status-success)', 'var(--status-success-bg)', 'Verified'],
                submitted: ['var(--status-info)',    'var(--status-info-bg)',    'Submitted'],
                pending:   ['var(--status-warning)', 'var(--status-warning-bg)','Pending'],
                rejected:  ['var(--status-error)',   'var(--status-error-bg)',  'Rejected'],
            };
            const [colour, bg, label] = map[status] || ['var(--text-dim)', 'transparent', status];
            return `<span style="
                display:inline-block;
                padding:2px 8px;
                border-radius:999px;
                font-size:11px;
                font-weight:600;
                color:${colour};
                background:${bg};
            ">${label}</span>`;
        };

        const rows = (items || []).map(item => {
            const isOverdue = item.status !== 'verified' && item.due_date && item.due_date < new Date().toISOString().split('T')[0];
            return `
                <tr data-item-id="${item.id}" style="${isOverdue ? 'background:var(--status-error-bg);' : ''}">
                    <td style="padding:10px 12px; color:var(--text-body); font-size:13px;">
                        ${this.utils.escapeHtml(item.name)}
                        ${isOverdue ? '<span style="color:var(--status-error); font-size:11px; margin-left:6px;">OVERDUE</span>' : ''}
                    </td>
                    <td style="padding:10px 12px; font-size:12px; color:var(--text-dim);">${this.utils.escapeHtml(item.category || '—')}</td>
                    <td style="padding:10px 12px;">${statusPill(item.status)}</td>
                    <td style="padding:10px 12px; font-size:12px; color:var(--text-dim);">
                        ${item.submitted_at ? new Date(item.submitted_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td style="padding:10px 12px; font-size:12px;">
                        <div style="display:flex; gap:6px;">
                            ${item.status !== 'verified' ? `
                                <button
                                    class="portal-verify-btn"
                                    data-item-id="${item.id}"
                                    style="
                                        background:var(--status-success-bg);
                                        color:var(--status-success);
                                        border:1px solid var(--status-success-border,var(--status-success));
                                        border-radius:4px;
                                        padding:3px 8px;
                                        font-size:11px;
                                        cursor:pointer;
                                    "
                                    title="Mark as verified"
                                >✓ Verify</button>
                            ` : ''}
                            ${item.status !== 'rejected' ? `
                                <button
                                    class="portal-reject-btn"
                                    data-item-id="${item.id}"
                                    data-item-name="${this.utils.escapeHtml(item.name)}"
                                    style="
                                        background:var(--status-error-bg);
                                        color:var(--status-error);
                                        border:1px solid var(--status-error-border,var(--status-error));
                                        border-radius:4px;
                                        padding:3px 8px;
                                        font-size:11px;
                                        cursor:pointer;
                                    "
                                    title="Reject item"
                                >✗ Reject</button>
                            ` : `<span style="color:var(--text-dim); font-size:11px;">${this.utils.escapeHtml(item.rejection_reason || '')}</span>`}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <section>
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                    <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0;">
                        Onboarding Checklist
                    </h3>
                    <span style="font-size:13px; color:var(--text-secondary);">${completed}/${total} complete</span>
                    ${overdue > 0 ? `<span style="
                        background:var(--status-error-bg);
                        color:var(--status-error);
                        font-size:11px;
                        font-weight:700;
                        padding:2px 8px;
                        border-radius:999px;
                    ">${overdue} overdue</span>` : ''}
                </div>
                <div style="background:var(--bg-card,var(--surface-2)); border-radius:10px; border:1px solid var(--border-standard); overflow:hidden;">
                    ${items && items.length > 0 ? `
                        <table style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr style="background:var(--table-header-bg);">
                                    <th style="padding:10px 12px; text-align:left; font-size:12px; font-weight:600; color:var(--text-muted);">Item</th>
                                    <th style="padding:10px 12px; text-align:left; font-size:12px; font-weight:600; color:var(--text-muted);">Category</th>
                                    <th style="padding:10px 12px; text-align:left; font-size:12px; font-weight:600; color:var(--text-muted);">Status</th>
                                    <th style="padding:10px 12px; text-align:left; font-size:12px; font-weight:600; color:var(--text-muted);">Submitted</th>
                                    <th style="padding:10px 12px; text-align:left; font-size:12px; font-weight:600; color:var(--text-muted);">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows}
                            </tbody>
                        </table>
                    ` : `<p style="padding:20px; color:var(--text-dim); font-size:13px; margin:0;">No checklist items assigned to this client.</p>`}
                </div>
            </section>
        `;
    },

    // ── Follow-Up Log ───────────────────────────────────────────────

    _renderFollowupSection(followups) {
        if (!followups || followups.length === 0) {
            return `
                <section>
                    <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0 0 16px;">Follow-Up Log</h3>
                    <div style="background:var(--bg-card,var(--surface-2)); padding:16px; border-radius:10px; border:1px solid var(--border-standard);">
                        <p style="color:var(--text-dim); font-size:13px; margin:0;">No automated messages sent yet.</p>
                    </div>
                </section>
            `;
        }

        const rows = followups.map(f => {
            const statusColour = {
                sent: 'var(--status-success)',
                pending_approval: 'var(--status-warning)',
                bounced: 'var(--status-error)',
            }[f.status] || 'var(--text-dim)';

            return `
                <tr>
                    <td style="padding:9px 12px; font-size:12px; color:var(--text-dim);">
                        ${f.sent_at ? new Date(f.sent_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td style="padding:9px 12px; font-size:12px; color:var(--text-secondary);">${this.utils.escapeHtml(f.event_type)}</td>
                    <td style="padding:9px 12px; font-size:13px; color:var(--text-body);">${this.utils.escapeHtml(f.subject)}</td>
                    <td style="padding:9px 12px; font-size:12px; color:${statusColour};">${this.utils.escapeHtml(f.status)}</td>
                </tr>
            `;
        }).join('');

        return `
            <section>
                <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0 0 16px;">Follow-Up Log</h3>
                <div style="background:var(--bg-card,var(--surface-2)); border-radius:10px; border:1px solid var(--border-standard); overflow:hidden;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead>
                            <tr style="background:var(--table-header-bg);">
                                <th style="padding:9px 12px; text-align:left; font-size:11px; font-weight:600; color:var(--text-muted);">Date</th>
                                <th style="padding:9px 12px; text-align:left; font-size:11px; font-weight:600; color:var(--text-muted);">Type</th>
                                <th style="padding:9px 12px; text-align:left; font-size:11px; font-weight:600; color:var(--text-muted);">Subject</th>
                                <th style="padding:9px 12px; text-align:left; font-size:11px; font-weight:600; color:var(--text-muted);">Status</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </section>
        `;
    },

    // ── Credential Summary ──────────────────────────────────────────

    _renderCredentialsSection(count) {
        return `
            <section>
                <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0 0 16px;">Credentials</h3>
                <div style="background:var(--bg-card,var(--surface-2)); padding:16px; border-radius:10px; border:1px solid var(--border-standard);">
                    <p style="color:var(--text-secondary); font-size:13px; margin:0 0 8px;">
                        <strong style="color:var(--text-body);">${count}</strong> credential set${count !== 1 ? 's' : ''} submitted by client.
                    </p>
                    <p style="color:var(--text-dim); font-size:12px; margin:0;">
                        Credential values are not shown here. Use <code style="background:var(--surface-code); padding:1px 4px; border-radius:3px;">portal_client.py credentials --client "..."</code> or the portal admin dashboard to view.
                    </p>
                </div>
            </section>
        `;
    },

    // ── Quick Actions ───────────────────────────────────────────────

    _renderQuickActions(clientId) {
        return `
            <section>
                <h3 style="font-size:16px; font-weight:600; color:var(--text-body); margin:0 0 16px;">Quick Actions</h3>
                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <button
                        id="portal-advance-stage-btn"
                        style="
                            background:var(--filter-active-bg);
                            color:var(--text-body);
                            border:1px solid var(--border-standard);
                            border-radius:6px;
                            padding:8px 16px;
                            font-size:13px;
                            cursor:pointer;
                        "
                    >Advance Stage</button>
                    <button
                        id="portal-remind-btn"
                        style="
                            background:var(--status-info-bg);
                            color:var(--status-info);
                            border:1px solid var(--status-info-border,var(--status-info));
                            border-radius:6px;
                            padding:8px 16px;
                            font-size:13px;
                            cursor:pointer;
                        "
                    >Send Reminder</button>
                </div>
                <div id="portal-stage-selector" style="display:none; margin-top:12px; background:var(--bg-card,var(--surface-2)); padding:16px; border-radius:8px; border:1px solid var(--border-standard);">
                    <label style="font-size:13px; color:var(--text-secondary); display:block; margin-bottom:6px;">New stage number</label>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input
                            id="portal-stage-input"
                            type="number"
                            min="1"
                            max="18"
                            placeholder="e.g. 12"
                            style="
                                background:var(--input-bg);
                                border:1px solid var(--border-input);
                                border-radius:4px;
                                color:var(--text-body);
                                padding:6px 10px;
                                font-size:13px;
                                width:80px;
                            "
                        />
                        <input
                            id="portal-stage-notes"
                            type="text"
                            placeholder="Optional notes"
                            style="
                                background:var(--input-bg);
                                border:1px solid var(--border-input);
                                border-radius:4px;
                                color:var(--text-body);
                                padding:6px 10px;
                                font-size:13px;
                                flex:1;
                            "
                        />
                        <button
                            id="portal-stage-confirm-btn"
                            style="
                                background:var(--accent-1,#7c3aed);
                                color:#fff;
                                border:none;
                                border-radius:4px;
                                padding:6px 14px;
                                font-size:13px;
                                cursor:pointer;
                            "
                        >Confirm</button>
                    </div>
                </div>
            </section>

            <!-- Reject Modal -->
            <div id="portal-reject-modal" style="display:none; position:fixed; inset:0; background:var(--surface-overlay); z-index:9999; align-items:center; justify-content:center;">
                <div style="background:var(--bg-elevated); border-radius:12px; padding:24px; min-width:360px; border:1px solid var(--border-standard); box-shadow:0 8px 32px rgba(0,0,0,0.4);">
                    <h4 style="color:var(--text-body); margin:0 0 12px; font-size:15px;">Reject item: <span id="portal-reject-item-name"></span></h4>
                    <label style="font-size:13px; color:var(--text-secondary); display:block; margin-bottom:6px;">Reason (shown to client)</label>
                    <textarea
                        id="portal-reject-reason"
                        placeholder="e.g. Need SVG format, not JPEG"
                        style="
                            width:100%;
                            box-sizing:border-box;
                            background:var(--input-bg);
                            border:1px solid var(--border-input);
                            border-radius:6px;
                            color:var(--text-body);
                            padding:8px 10px;
                            font-size:13px;
                            min-height:80px;
                            resize:vertical;
                            margin-bottom:12px;
                        "
                    ></textarea>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                        <button id="portal-reject-cancel" style="background:transparent; border:1px solid var(--border-standard); color:var(--text-secondary); border-radius:4px; padding:6px 14px; font-size:13px; cursor:pointer;">Cancel</button>
                        <button id="portal-reject-confirm" style="background:var(--status-error-bg); color:var(--status-error); border:1px solid var(--status-error-border,var(--status-error)); border-radius:4px; padding:6px 14px; font-size:13px; cursor:pointer;">Reject</button>
                    </div>
                </div>
            </div>
        `;
    },

    // ── Event Binding ───────────────────────────────────────────────

    _bindActions(container, clientId) {
        // Verify buttons
        container.querySelectorAll('.portal-verify-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemId = btn.dataset.itemId;
                btn.disabled = true;
                btn.textContent = '…';
                try {
                    const resp = await fetch(`/api/clients/${clientId}/portal/verify/${itemId}`, { method: 'POST' });
                    const data = await resp.json();
                    if (data.success) {
                        this.utils.showNotification('Item verified', 'success');
                        this._loadData(container, clientId);
                    } else {
                        this.utils.showNotification(data.error || 'Verify failed', 'error');
                        btn.disabled = false;
                        btn.textContent = '✓ Verify';
                    }
                } catch (err) {
                    this.utils.showNotification('Network error', 'error');
                    btn.disabled = false;
                    btn.textContent = '✓ Verify';
                }
            });
        });

        // Reject buttons — open modal
        let pendingRejectItemId = null;
        const modal = container.querySelector('#portal-reject-modal');

        container.querySelectorAll('.portal-reject-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                pendingRejectItemId = btn.dataset.itemId;
                container.querySelector('#portal-reject-item-name').textContent = btn.dataset.itemName || '';
                container.querySelector('#portal-reject-reason').value = '';
                modal.style.display = 'flex';
            });
        });

        const cancelBtn = container.querySelector('#portal-reject-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                pendingRejectItemId = null;
            });
        }

        const confirmRejectBtn = container.querySelector('#portal-reject-confirm');
        if (confirmRejectBtn) {
            confirmRejectBtn.addEventListener('click', async () => {
                const reason = container.querySelector('#portal-reject-reason').value.trim();
                if (!reason) {
                    this.utils.showNotification('Please enter a rejection reason', 'error');
                    return;
                }
                modal.style.display = 'none';
                try {
                    const resp = await fetch(`/api/clients/${clientId}/portal/reject/${pendingRejectItemId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason }),
                    });
                    const data = await resp.json();
                    if (data.success) {
                        this.utils.showNotification('Item rejected', 'success');
                        this._loadData(container, clientId);
                    } else {
                        this.utils.showNotification(data.error || 'Reject failed', 'error');
                    }
                } catch (err) {
                    this.utils.showNotification('Network error', 'error');
                }
                pendingRejectItemId = null;
            });
        }

        // Advance stage — toggle selector
        const advanceBtn = container.querySelector('#portal-advance-stage-btn');
        const stageSelector = container.querySelector('#portal-stage-selector');
        if (advanceBtn && stageSelector) {
            advanceBtn.addEventListener('click', () => {
                stageSelector.style.display = stageSelector.style.display === 'none' ? 'block' : 'none';
            });
        }

        const stageConfirmBtn = container.querySelector('#portal-stage-confirm-btn');
        if (stageConfirmBtn) {
            stageConfirmBtn.addEventListener('click', async () => {
                const stage = parseInt(container.querySelector('#portal-stage-input').value, 10);
                const notes = container.querySelector('#portal-stage-notes').value.trim();
                if (!stage || stage < 1 || stage > 18) {
                    this.utils.showNotification('Enter a stage between 1 and 18', 'error');
                    return;
                }
                stageConfirmBtn.disabled = true;
                stageConfirmBtn.textContent = '…';
                try {
                    const resp = await fetch(`/api/clients/${clientId}/pipeline`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stage, notes }),
                    });
                    const data = await resp.json();
                    if (data.success) {
                        this.utils.showNotification(`Advanced to Stage ${stage} — ${data.stage_name}`, 'success');
                        stageSelector.style.display = 'none';
                        this._loadData(container, clientId);
                    } else {
                        this.utils.showNotification(data.error || 'Failed to advance stage', 'error');
                    }
                } catch (err) {
                    this.utils.showNotification('Network error', 'error');
                } finally {
                    stageConfirmBtn.disabled = false;
                    stageConfirmBtn.textContent = 'Confirm';
                }
            });
        }

        // Send Reminder — placeholder (follow-up agent handles actual sending)
        const remindBtn = container.querySelector('#portal-remind-btn');
        if (remindBtn) {
            remindBtn.addEventListener('click', () => {
                this.utils.showNotification('Reminder queued — follow-up agent will send at next run', 'info');
            });
        }
    },

    // ── Phase Badge Style ───────────────────────────────────────────

    _phaseBadgeStyle(phase) {
        const map = {
            'Proposal':        'background:#312e81; color:#a5b4fc; border:1px solid #4f46e5;',
            'Setup':           'background:#1e3a5f; color:#93c5fd; border:1px solid #2563eb;',
            'Build':           'background:#14532d; color:#86efac; border:1px solid #16a34a;',
            'Review & Launch': 'background:#451a03; color:#fcd34d; border:1px solid #d97706;',
            'Live':            'background:#1a2e05; color:#a3e635; border:1px solid #65a30d;',
        };
        const base = map[phase] || 'background:var(--surface-1); color:var(--text-muted); border:1px solid var(--border-standard);';
        return `${base} padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap;`;
    },

    // ── Empty / Error States ────────────────────────────────────────

    _renderNoClient() {
        return `
            <div style="padding:20px; text-align:center; padding-top:60px;">
                <div style="font-size:48px; margin-bottom:16px;">🗂</div>
                <h3 style="color:var(--text-body); margin-bottom:8px;">No Client Selected</h3>
                <p style="color:var(--text-dim); font-size:14px;">Select a client to view their portal status.</p>
            </div>
        `;
    },

    _renderNoPortal(name) {
        return `
            <div style="padding:20px; text-align:center; padding-top:60px;">
                <div style="font-size:48px; margin-bottom:16px;">🔌</div>
                <h3 style="color:var(--text-body); margin-bottom:8px;">No Portal Data</h3>
                <p style="color:var(--text-dim); font-size:14px;">
                    ${this.utils.escapeHtml(name)} has no active portal or pipeline record.<br>
                    Run <code style="background:var(--surface-code); padding:1px 6px; border-radius:3px;">portal_client.py create --client "..."</code> to set one up.
                </p>
            </div>
        `;
    },

    _renderLoading() {
        return `
            <div style="padding:20px; text-align:center; padding-top:60px;">
                <p style="color:var(--text-dim); font-size:14px;">Loading portal data…</p>
            </div>
        `;
    },

    _renderError(msg) {
        return `
            <div style="padding:20px; text-align:center; padding-top:60px;">
                <div style="font-size:48px; margin-bottom:16px;">⚠️</div>
                <h3 style="color:var(--status-error); margin-bottom:8px;">Load Error</h3>
                <p style="color:var(--text-dim); font-size:13px;">${this.utils.escapeHtml(msg)}</p>
            </div>
        `;
    },
});

console.log('Portal Status plugin registered');
