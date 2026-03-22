// Settings Management
let currentSettings = {};
let defaultSettings = {
    // Crawler settings
    maxDepth: 3,
    maxUrls: 5000000,
    crawlDelay: 1,
    followRedirects: true,
    crawlExternalLinks: false,

    // Request settings
    userAgent: 'LibreCrawl/1.0 (Web Crawler)',
    timeout: 10,
    retries: 3,
    acceptLanguage: 'en-US,en;q=0.9',
    respectRobotsTxt: true,
    allowCookies: true,
    discoverSitemaps: true,
    enablePageSpeed: false,
    googleApiKey: '',
    google_places_api_key: '',

    // Filter settings
    includeExtensions: 'html,htm,php,asp,aspx,jsp',
    excludeExtensions: 'pdf,doc,docx,zip,exe,dmg',
    includePatterns: '',
    excludePatterns: '',
    maxFileSize: 50,

    // Duplication detection settings
    enableDuplicationCheck: true,
    duplicationThreshold: 0.85,

    // Export settings
    exportFormat: 'csv',
    exportFields: ['url', 'status_code', 'title', 'meta_description', 'h1', 'word_count', 'response_time', 'analytics', 'og_tags', 'json_ld', 'internal_links', 'external_links', 'images'],

    // Advanced settings
    concurrency: 5,
    memoryLimit: 512,
    logLevel: 'INFO',
    saveSession: false,
    enableProxy: false,
    proxyUrl: '',
    customHeaders: '',

    // JavaScript rendering settings
    enableJavaScript: false,
    jsWaitTime: 3,
    jsTimeout: 30,
    jsBrowser: 'chromium',
    jsHeadless: true,
    jsUserAgent: 'LibreCrawl/1.0 (Web Crawler with JavaScript)',
    jsViewportWidth: 1920,
    jsViewportHeight: 1080,
    jsMaxConcurrentPages: 3,

    // Custom CSS styling
    customCSS: '',

    // Theme preference
    theme: 'dark',

    // Issue exclusion patterns
    issueExclusionPatterns: `# WordPress admin & system paths
/wp-admin/*
/wp-content/plugins/*
/wp-content/themes/*
/wp-content/uploads/*
/wp-includes/*
/wp-login.php
/wp-cron.php
/xmlrpc.php
/wp-json/*
/wp-activate.php
/wp-signup.php
/wp-trackback.php

# Auth & user management pages
/login*
/signin*
/sign-in*
/log-in*
/auth/*
/authenticate/*
/register*
/signup*
/sign-up*
/registration/*
/logout*
/signout*
/sign-out*
/log-out*
/forgot-password*
/reset-password*
/password-reset*
/recover-password*
/change-password*
/account/password/*
/user/password/*
/activate/*
/verification/*
/verify/*
/confirm/*

# Admin panels & dashboards
/admin/*
/administrator/*
/_admin/*
/backend/*
/dashboard/*
/cpanel/*
/phpmyadmin/*
/pma/*
/webmail/*
/plesk/*
/control-panel/*
/manage/*
/manager/*

# E-commerce checkout & cart
/checkout/*
/cart/*
/basket/*
/payment/*
/billing/*
/order/*
/orders/*
/purchase/*

# User account pages
/account/*
/profile/*
/settings/*
/preferences/*
/my-account/*
/user/*
/member/*
/members/*

# CGI & server scripts
/cgi-bin/*
/cgi/*
/fcgi-bin/*

# Version control & config
/.git/*
/.svn/*
/.hg/*
/.bzr/*
/.cvs/*
/.env
/.env.*
/.htaccess
/.htpasswd
/web.config
/app.config
/composer.json
/package.json

# Development & build artifacts
/node_modules/*
/vendor/*
/bower_components/*
/jspm_packages/*
/includes/*
/lib/*
/libs/*
/src/*
/dist/*
/build/*
/builds/*
/_next/*
/.next/*
/out/*
/_nuxt/*
/.nuxt/*

# Testing & development
/test/*
/tests/*
/spec/*
/specs/*
/__tests__/*
/debug/*
/dev/*
/development/*
/staging/*

# API internal endpoints
/api/internal/*
/api/admin/*
/api/private/*

# System & internal
/private/*
/system/*
/core/*
/internal/*
/tmp/*
/temp/*
/cache/*
/logs/*
/log/*
/backup/*
/backups/*
/old/*
/archive/*
/archives/*
/config/*
/configs/*
/configuration/*

# Media upload forms
/upload/*
/uploads/*
/uploader/*
/file-upload/*

# Search & filtering (often noisy for SEO)
/search*
*/search/*
?s=*
?search=*
*/filter/*
?filter=*
*/sort/*
?sort=*

# Printer-friendly & special views
/print/*
?print=*
/preview/*
?preview=*
/embed/*
?embed=*
/amp/*
/amp

# Feed URLs
/feed/*
/feeds/*
/rss/*
*.rss
/atom/*
*.atom

# Common file types to exclude from issues
*.json
*.xml
*.yaml
*.yml
*.toml
*.ini
*.conf
*.log
*.txt
*.csv
*.sql
*.db
*.bak
*.backup
*.old
*.orig
*.tmp
*.swp
*.map
*.min.js
*.min.css`
};

// Initialize settings when page loads
document.addEventListener('DOMContentLoaded', function() {
    loadSettings();
    setupSettingsEventHandlers();
    applyCustomCSS();
});

function setupSettingsEventHandlers() {
    // Proxy checkbox handler
    const enableProxyCheckbox = document.getElementById('enableProxy');
    if (enableProxyCheckbox) {
        enableProxyCheckbox.addEventListener('change', function() {
            const proxySettings = document.getElementById('proxySettings');
            if (proxySettings) {
                proxySettings.style.display = this.checked ? 'block' : 'none';
            }
        });
    }

    // JavaScript checkbox handler
    const enableJavaScriptCheckbox = document.getElementById('enableJavaScript');
    if (enableJavaScriptCheckbox) {
        enableJavaScriptCheckbox.addEventListener('change', function() {
            const jsSettingsGroups = [
                'jsSettings', 'jsTimeoutGroup', 'jsBrowserGroup', 'jsHeadlessGroup',
                'jsUserAgentGroup', 'jsViewportGroup', 'jsConcurrencyGroup', 'jsWarning'
            ];

            jsSettingsGroups.forEach(groupId => {
                const group = document.getElementById(groupId);
                if (group) {
                    group.style.display = this.checked ? 'block' : 'none';
                }
            });
        });
    }
}

function resetIssueExclusions() {
    // Always use the hardcoded defaults, not current settings
    document.getElementById('issueExclusionPatterns').value = defaultSettings.issueExclusionPatterns;
    alert('Issue exclusion patterns have been reset to defaults');
}

async function openSettings() {
    // Show modal immediately with current settings
    populateSettingsForm();
    document.getElementById('settingsModal').style.display = 'flex';

    // Focus first input
    const firstInput = document.querySelector('.settings-tab-content.active input, .settings-tab-content.active select');
    if (firstInput) {
        setTimeout(() => firstInput.focus(), 100);
    }

    // Fetch user tier in background and apply restrictions
    let userTier = 'guest';
    try {
        const response = await fetch('/api/user/info');
        const data = await response.json();
        if (data.success) {
            userTier = data.user.tier;
        }
    } catch (error) {
        console.error('Failed to get user tier:', error);
    }

    // Block guests from accessing settings
    if (userTier === 'guest') {
        document.getElementById('settingsModal').style.display = 'none';
        alert('Settings are not available for guest users.\n\nPlease register for a free account to customize crawler settings, filters, and more.\n\nClick "Logout" and then "Register here" to create an account.');
        return;
    }

    // Hide tabs based on tier
    applyTierRestrictions(userTier);
}

function applyTierRestrictions(tier) {
    // Define which tabs each tier can see - MUST MATCH HTML TAB NAMES
    const tierTabs = {
        'guest': [],  // No settings tabs for guests
        'user': ['crawler', 'export', 'issues', 'appearance'],
        'extra': ['crawler', 'export', 'issues', 'filters', 'requests', 'customcss', 'javascript', 'appearance'],
        'admin': ['crawler', 'requests', 'filters', 'export', 'javascript', 'issues', 'customcss', 'advanced', 'appearance', 'social']
    };

    const allowedTabs = tierTabs[tier] || [];

    // Hide/show tab buttons based on tier
    const allTabButtons = document.querySelectorAll('.settings-tab-btn');
    allTabButtons.forEach(btn => {
        const tabName = btn.getAttribute('onclick').match(/switchSettingsTab\('(.+?)'\)/)[1];
        if (allowedTabs.includes(tabName)) {
            btn.style.display = 'inline-block';
        } else {
            btn.style.display = 'none';
        }
    });

    // If current active tab is not allowed, switch to first allowed tab
    const activeTab = document.querySelector('.settings-tab-btn.active');
    if (activeTab && activeTab.style.display === 'none' && allowedTabs.length > 0) {
        // Click the first visible tab
        const firstVisibleTab = document.querySelector('.settings-tab-btn[style*="inline-block"]');
        if (firstVisibleTab) {
            firstVisibleTab.click();
        }
    }

    // Show message for guests
    if (tier === 'guest') {
        const settingsContent = document.querySelector('.settings-tabs');
        if (settingsContent) {
            const message = document.createElement('div');
            message.style.cssText = 'padding: 40px; text-align: center; color: var(--text-dim); font-size: 16px;';
            message.innerHTML = `
                <h3 style="color: var(--text-body); margin-bottom: 16px;">Settings Access Restricted</h3>
                <p>Guest accounts cannot modify settings.</p>
                <p style="margin-top: 8px; font-size: 14px;">Please upgrade your account to access settings.</p>
            `;
            settingsContent.innerHTML = '';
            settingsContent.appendChild(message);
        }
    }
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

function switchSettingsTab(tabName) {
    // Remove active class from all tabs and content
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
    });

    // Add active class to selected tab button (find by matching onclick attribute)
    const activeBtn = document.querySelector(`.settings-tab-btn[onclick="switchSettingsTab('${tabName}')"]`);
    if (activeBtn) activeBtn.classList.add('active');

    // Add active class to selected content panel
    const panel = document.getElementById(tabName + '-settings');
    if (panel) panel.classList.add('active');

    // Tab-specific activation hooks
    if (tabName === 'social') {
        loadSocialStatus();
    }
}

function populateSettingsForm() {
    // Populate all form fields with current settings
    Object.keys(currentSettings).forEach(key => {
        const element = document.getElementById(key);
        if (element) {
            if (element.type === 'checkbox') {
                element.checked = currentSettings[key];
            } else {
                element.value = currentSettings[key];
            }
        }
    });

    // Handle export fields checkboxes
    const exportFieldsCheckboxes = document.querySelectorAll('input[name="exportFields"]');
    exportFieldsCheckboxes.forEach(checkbox => {
        checkbox.checked = currentSettings.exportFields.includes(checkbox.value);
    });

    // Set theme radio
    const themeRadio = document.querySelector(`input[name="theme"][value="${currentSettings.theme || 'dark'}"]`);
    if (themeRadio) themeRadio.checked = true;

    // Set layout radio + apply immediately on change
    const currentLayout = localStorage.getItem('librecrawl_layout') || 'sidebar';
    const layoutRadioEl = document.querySelector(`input[name="layout"][value="${currentLayout}"]`);
    if (layoutRadioEl) layoutRadioEl.checked = true;
    document.querySelectorAll('input[name="layout"]').forEach(radio => {
        radio.onchange = () => applyLayout(radio.value);
    });

    // Show/hide proxy settings
    const enableProxy = currentSettings.enableProxy;
    const proxySettings = document.getElementById('proxySettings');
    if (proxySettings) {
        proxySettings.style.display = enableProxy ? 'block' : 'none';
    }

    // Show/hide JavaScript settings
    const enableJavaScript = currentSettings.enableJavaScript;
    const jsSettingsGroups = [
        'jsSettings', 'jsTimeoutGroup', 'jsBrowserGroup', 'jsHeadlessGroup',
        'jsUserAgentGroup', 'jsViewportGroup', 'jsConcurrencyGroup', 'jsWarning'
    ];

    jsSettingsGroups.forEach(groupId => {
        const group = document.getElementById(groupId);
        if (group) {
            group.style.display = enableJavaScript ? 'block' : 'none';
        }
    });
}

function collectSettingsFromForm() {
    const settings = {};

    // Collect regular form fields
    const formFields = [
        'maxDepth', 'maxUrls', 'crawlDelay', 'followRedirects', 'crawlExternalLinks',
        'userAgent', 'timeout', 'retries', 'acceptLanguage', 'respectRobotsTxt', 'allowCookies', 'discoverSitemaps', 'enablePageSpeed', 'googleApiKey', 'google_places_api_key',
        'includeExtensions', 'excludeExtensions', 'includePatterns', 'excludePatterns', 'maxFileSize',
        'enableDuplicationCheck', 'duplicationThreshold',
        'exportFormat', 'concurrency', 'memoryLimit', 'logLevel', 'saveSession',
        'enableProxy', 'proxyUrl', 'customHeaders',
        'enableJavaScript', 'jsWaitTime', 'jsTimeout', 'jsBrowser', 'jsHeadless', 'jsUserAgent', 'jsViewportWidth', 'jsViewportHeight', 'jsMaxConcurrentPages',
        'customCSS', 'issueExclusionPatterns'
    ];

    formFields.forEach(fieldId => {
        const element = document.getElementById(fieldId);
        if (element) {
            if (element.type === 'checkbox') {
                settings[fieldId] = element.checked;
            } else if (element.type === 'number') {
                settings[fieldId] = parseFloat(element.value) || 0;
            } else {
                settings[fieldId] = element.value;
            }
        }
    });

    // Collect export fields
    const exportFieldsCheckboxes = document.querySelectorAll('input[name="exportFields"]:checked');
    settings.exportFields = Array.from(exportFieldsCheckboxes).map(cb => cb.value);

    // Collect theme
    const themeRadio = document.querySelector('input[name="theme"]:checked');
    if (themeRadio) settings.theme = themeRadio.value;

    // Apply layout immediately (stored in localStorage, not server settings)
    const layoutRadio = document.querySelector('input[name="layout"]:checked');
    if (layoutRadio) applyLayout(layoutRadio.value);

    return settings;
}

function saveSettings() {
    // Collect settings from form
    const newSettings = collectSettingsFromForm();

    // Validate settings
    const validation = validateSettings(newSettings);
    if (!validation.valid) {
        alert('Settings validation failed: ' + validation.errors.join(', '));
        return;
    }

    // Save to localStorage first (primary storage for persistence)
    try {
        localStorage.setItem('librecrawl_settings', JSON.stringify(newSettings));
        console.log('Settings saved to localStorage');
    } catch (error) {
        console.error('Failed to save to localStorage:', error);
        showNotification('Warning: Settings may not persist', 'warning');
    }

    // Update current settings
    currentSettings = { ...newSettings };

    // Apply custom CSS immediately
    applyCustomCSS();

    // Apply theme immediately
    applyTheme(currentSettings.theme || 'dark');
    updateThemeToggleButton(currentSettings.theme || 'dark');

    // Close settings modal
    closeSettings();
    showNotification('Settings saved successfully', 'success');

    // Sync to backend for crawler configuration
    fetch('/api/save_settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(newSettings)
    })
    .then(response => response.json())
    .then(data => {
        if (!data.success) {
            console.warn('Backend sync failed:', data.error);
        }

        // Update crawler with new settings if it's running
        if (window.crawlState && window.crawlState.isRunning) {
            updateCrawlerSettings();
        }
    })
    .catch(error => {
        console.error('Error syncing settings to backend:', error);
    });
}

function resetSettings() {
    if (confirm('Are you sure you want to reset all settings to their default values?')) {
        currentSettings = { ...defaultSettings };

        // Clear localStorage
        try {
            localStorage.removeItem('librecrawl_settings');
            console.log('Settings cleared from localStorage');
        } catch (error) {
            console.error('Failed to clear localStorage:', error);
        }

        populateSettingsForm();
        applyCustomCSS(); // Remove any custom CSS
        showNotification('Settings reset to defaults', 'info');

        // Sync reset to backend
        syncSettingsToBackend();
    }
}

function validateSettings(settings) {
    const errors = [];

    // Validate numeric ranges
    if (settings.maxDepth < 1 || settings.maxDepth > 10) {
        errors.push('Max depth must be between 1 and 10');
    }

    if (settings.maxUrls < 1 || settings.maxUrls > 5000000) {
        errors.push('Max URLs must be between 1 and 5,000,000');
    }

    if (settings.crawlDelay < 0 || settings.crawlDelay > 60) {
        errors.push('Crawl delay must be between 0 and 60 seconds');
    }

    if (settings.timeout < 1 || settings.timeout > 120) {
        errors.push('Timeout must be between 1 and 120 seconds');
    }

    if (settings.retries < 0 || settings.retries > 10) {
        errors.push('Retries must be between 0 and 10');
    }

    if (settings.maxFileSize < 1 || settings.maxFileSize > 1000) {
        errors.push('Max file size must be between 1 and 1000 MB');
    }

    if (settings.concurrency < 1 || settings.concurrency > 50) {
        errors.push('Concurrency must be between 1 and 50');
    }

    if (settings.memoryLimit < 64 || settings.memoryLimit > 4096) {
        errors.push('Memory limit must be between 64 and 4096 MB');
    }

    // Validate duplication detection settings
    if (settings.duplicationThreshold < 0 || settings.duplicationThreshold > 1) {
        errors.push('Duplication threshold must be between 0.0 and 1.0');
    }

    // Validate JavaScript settings if enabled
    if (settings.enableJavaScript) {
        if (settings.jsWaitTime < 0 || settings.jsWaitTime > 30) {
            errors.push('JavaScript wait time must be between 0 and 30 seconds');
        }

        if (settings.jsTimeout < 5 || settings.jsTimeout > 120) {
            errors.push('JavaScript timeout must be between 5 and 120 seconds');
        }

        if (settings.jsViewportWidth < 800 || settings.jsViewportWidth > 4000) {
            errors.push('JavaScript viewport width must be between 800 and 4000 pixels');
        }

        if (settings.jsViewportHeight < 600 || settings.jsViewportHeight > 3000) {
            errors.push('JavaScript viewport height must be between 600 and 3000 pixels');
        }

        if (settings.jsMaxConcurrentPages < 1 || settings.jsMaxConcurrentPages > 10) {
            errors.push('JavaScript concurrent pages must be between 1 and 10');
        }

        if (!settings.jsUserAgent.trim()) {
            errors.push('JavaScript user agent cannot be empty');
        }
    }

    // Validate proxy URL if proxy is enabled
    if (settings.enableProxy && settings.proxyUrl) {
        try {
            new URL(settings.proxyUrl);
        } catch (e) {
            errors.push('Invalid proxy URL format');
        }
    }

    // Validate user agent
    if (!settings.userAgent.trim()) {
        errors.push('User agent cannot be empty');
    }

    // Validate export fields
    if (settings.exportFields.length === 0) {
        errors.push('At least one export field must be selected');
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

function loadSettings() {
    // Try to load from localStorage first (browser-specific persistence)
    try {
        const savedSettings = localStorage.getItem('librecrawl_settings');
        if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            currentSettings = { ...defaultSettings, ...parsed };
            console.log('Settings loaded from localStorage');

            // Apply custom CSS after loading settings
            applyCustomCSS();

            // Apply theme
            const savedTheme = localStorage.getItem('librecrawl_theme') || currentSettings.theme || 'dark';
            applyTheme(savedTheme);
            updateThemeToggleButton(savedTheme);

            // Sync to backend for crawler configuration
            syncSettingsToBackend();
            return;
        }
    } catch (error) {
        console.warn('Failed to load settings from localStorage:', error);
    }

    // Fallback: Load from backend (legacy support)
    fetch('/api/get_settings')
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                currentSettings = { ...defaultSettings, ...data.settings };
                // Save to localStorage for future loads
                localStorage.setItem('librecrawl_settings', JSON.stringify(currentSettings));
                // Apply custom CSS after loading settings
                applyCustomCSS();
            } else {
                console.warn('Failed to load settings, using defaults');
                currentSettings = { ...defaultSettings };
            }
            // Apply theme (runs in both success and fallback paths)
            const savedTheme = localStorage.getItem('librecrawl_theme') || currentSettings.theme || 'dark';
            applyTheme(savedTheme);
            updateThemeToggleButton(savedTheme);
        })
        .catch(error => {
            console.error('Error loading settings:', error);
            currentSettings = { ...defaultSettings };
            const savedTheme = localStorage.getItem('librecrawl_theme') || 'dark';
            applyTheme(savedTheme);
            updateThemeToggleButton(savedTheme);
        });
}

function syncSettingsToBackend() {
    // Send settings to backend without waiting for response
    // This ensures crawler gets the right config
    fetch('/api/save_settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(currentSettings)
    }).catch(error => {
        console.warn('Failed to sync settings to backend:', error);
    });
}

function updateCrawlerSettings() {
    // Send updated settings to crawler
    fetch('/api/update_crawler_settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(currentSettings)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            console.log('Crawler settings updated');
        } else {
            console.warn('Failed to update crawler settings:', data.error);
        }
    })
    .catch(error => {
        console.error('Error updating crawler settings:', error);
    });
}

function exportSettings() {
    // Create downloadable settings file
    const settingsBlob = new Blob([JSON.stringify(currentSettings, null, 2)], {
        type: 'application/json'
    });

    const url = URL.createObjectURL(settingsBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'librecrawl-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedSettings = JSON.parse(e.target.result);

            // Validate imported settings
            const validation = validateSettings(importedSettings);
            if (!validation.valid) {
                alert('Invalid settings file: ' + validation.errors.join(', '));
                return;
            }

            // Merge with defaults to ensure all fields are present
            currentSettings = { ...defaultSettings, ...importedSettings };
            populateSettingsForm();
            showNotification('Settings imported successfully', 'success');

        } catch (error) {
            alert('Invalid settings file format');
        }
    };
    reader.readAsText(file);
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 6px;
        color: white;
        font-weight: 500;
        z-index: 1001;
        max-width: 300px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        transition: all 0.3s ease;
    `;

    // Set background color based on type
    switch (type) {
        case 'success':
            notification.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            break;
        case 'error':
            notification.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
            break;
        case 'warning':
            notification.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            break;
        default:
            notification.style.background = 'linear-gradient(135deg, #8b5cf6, #7c3aed)';
    }

    // Add to page
    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Close modal when clicking outside
document.addEventListener('click', function(event) {
    const modal = document.getElementById('settingsModal');
    if (event.target === modal) {
        closeSettings();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        const modal = document.getElementById('settingsModal');
        if (modal.style.display === 'flex') {
            closeSettings();
        }
    }
});

// Export current settings object for use by other modules
window.getCurrentSettings = function() {
    return currentSettings;
};

function applyTheme(theme) {
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    try { localStorage.setItem('librecrawl_theme', theme); } catch(e) {}
}

function applyLayout(layout) {
    document.documentElement.setAttribute('data-layout', layout || 'sidebar');
    try { localStorage.setItem('librecrawl_layout', layout); } catch(e) {}
}

function updateThemeToggleButton(theme) {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    if (theme === 'light') {
        btn.title = 'Switch to dark theme';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
    } else {
        btn.title = 'Switch to light theme';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    }
}

function toggleTheme() {
    const current = localStorage.getItem('librecrawl_theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    currentSettings.theme = next;
    applyTheme(next);
    updateThemeToggleButton(next);
    // Sync the radio in settings modal if open
    const radio = document.querySelector(`input[name="theme"][value="${next}"]`);
    if (radio) radio.checked = true;
}

// --- Social Account Connections ---

var SOCIAL_PLATFORMS_META = {
    facebook:  { label: 'Facebook',    icon: '🔵', userPlaceholder: 'your@email.com',     passLabel: 'Password' },
    instagram: { label: 'Instagram',   icon: '📸', userPlaceholder: 'username',            passLabel: 'Password' },
    linkedin:  { label: 'LinkedIn',    icon: '💼', userPlaceholder: 'your@email.com',     passLabel: 'Password' },
    twitter:   { label: 'X / Twitter', icon: '🐦', userPlaceholder: '@username or email', passLabel: 'Password' },
    tiktok:    { label: 'TikTok',      icon: '🎵', userPlaceholder: 'your@email.com',     passLabel: 'Password' }
};

function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _applySocialStatus(socialCookies, socialCredentials) {
    _renderSocialTab(socialCookies || {}, socialCredentials || {});
}

function _renderSocialTab(socialCookies, socialCredentials) {
    var list = document.getElementById('social-accounts-list');
    var emptyState = document.getElementById('social-empty-state');
    var picker = document.getElementById('social-platform-picker');
    if (!list) return;

    // Render connected accounts
    list.innerHTML = '';
    var connectedCount = 0;
    Object.keys(SOCIAL_PLATFORMS_META).forEach(function(platform) {
        var cookies = socialCookies[platform];
        if (!cookies || !cookies.length) return;
        connectedCount++;
        var meta = SOCIAL_PLATFORMS_META[platform];

        // Token hint: name + first 8 chars of value of first meaningful cookie
        var tokenHint = '';
        var tokenName = '';
        // Prefer known session cookie names
        var preferredNames = { facebook: 'c_user', instagram: 'sessionid', linkedin: 'li_at', twitter: 'auth_token', tiktok: 'sessionid' };
        var preferred = preferredNames[platform];
        var tokenCookie = cookies.find(function(c) { return c.name === preferred; }) || cookies[0];
        if (tokenCookie) {
            tokenName = tokenCookie.name;
            tokenHint = (tokenCookie.value || '').substring(0, 8) + '\u2026';
        }

        var testPlaceholder = platform === 'twitter' ? 'https://x.com/yourpage' : 'https://' + platform + '.com/yourpage';
        var card = document.createElement('div');
        card.style.cssText = 'padding:14px 0;border-bottom:1px solid var(--border-alt)';
        card.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
                '<span style="min-width:140px;color:var(--text-body);font-weight:500">' + escHtml(meta.icon + ' ' + meta.label) + '</span>' +
                '<span style="font-size:12px;flex:1"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:5px;vertical-align:middle"></span><span style="color:var(--text-body)">Connected</span>' + (tokenName ? '<span style="color:var(--text-muted)"> \u00B7 Token: ' + escHtml(tokenName) + ': ' + escHtml(tokenHint) + '</span>' : '') + '</span>' +
                '<button class="btn btn-danger" onclick="socialDisconnect(\'' + platform + '\')">Disconnect</button>' +
            '</div>' +
            '<div class="setting-group" style="margin-bottom:0">' +
                '<label style="font-size:12px;color:var(--text-muted)">Test extraction — paste a ' + escHtml(meta.label) + ' URL:</label>' +
                '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
                    '<input id="social-test-url-' + platform + '" type="text" placeholder="' + escHtml(testPlaceholder) + '" style="flex:1">' +
                    '<button class="btn btn-secondary" onclick="testSocialExtraction(\'' + platform + '\')">Test</button>' +
                '</div>' +
                '<div id="social-test-result-' + platform + '" style="display:none;margin-top:8px;padding:10px;background:var(--bg-secondary);border-radius:6px;font-size:12px;color:var(--text-body);max-height:200px;overflow-y:auto"></div>' +
            '</div>';
        list.appendChild(card);
    });

    // Empty state
    if (emptyState) emptyState.style.display = connectedCount === 0 ? 'block' : 'none';

    // Populate platform picker (unconnected platforms only)
    if (picker) {
        picker.innerHTML = '';
        var hasUnconnected = false;
        Object.keys(SOCIAL_PLATFORMS_META).forEach(function(platform) {
            var cookies = socialCookies[platform];
            if (cookies && cookies.length) return;
            hasUnconnected = true;
            var meta = SOCIAL_PLATFORMS_META[platform];
            var btn = document.createElement('button');
            btn.className = 'btn btn-secondary';
            btn.textContent = meta.icon + ' ' + meta.label;
            btn.onclick = (function(p) { return function() { selectSocialPlatform(p, socialCredentials); }; })(platform);
            picker.appendChild(btn);
        });
        var toggleBtn = document.getElementById('social-add-toggle-btn');
        if (toggleBtn) toggleBtn.style.display = hasUnconnected ? '' : 'none';
    }
}

function toggleSocialAddPanel() {
    var panel = document.getElementById('social-add-panel');
    if (!panel) return;
    var isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    var btn = document.getElementById('social-add-toggle-btn');
    if (btn) btn.textContent = isOpen ? '+ Add Account' : '\u2212 Close';
    if (isOpen) closeSocialAddForm();
}

function selectSocialPlatform(platform, socialCredentials) {
    var meta = SOCIAL_PLATFORMS_META[platform];
    if (!meta) return;
    var creds = (socialCredentials || {})[platform] || {};
    var form = document.getElementById('social-connect-form');
    if (!form) return;
    form.style.display = 'block';
    form.innerHTML =
        '<div style="font-weight:500;margin-bottom:12px;color:var(--text-body)">' + escHtml(meta.icon + ' Connect ' + meta.label) + '</div>' +
        '<div class="setting-group" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:0">' +
            '<div><label>Email / Username</label><input id="social-add-user" type="text" placeholder="' + escHtml(meta.userPlaceholder) + '" autocomplete="off" value="' + escHtml(creds.username || '') + '"></div>' +
            '<div><label>' + escHtml(meta.passLabel) + '</label><input id="social-add-pass" type="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autocomplete="new-password" value="' + escHtml(creds.password || '') + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
            '<button class="btn btn-primary" onclick="saveAndConnectSocial(\'' + platform + '\')">Save &amp; Connect</button>' +
            '<button class="btn btn-secondary" onclick="connectSocialOnly(\'' + platform + '\')">Connect (don\'t save)</button>' +
            '<button class="btn btn-secondary" onclick="closeSocialAddForm()">Cancel</button>' +
        '</div>' +
        '<p class="setting-help" style="margin-top:8px">Credentials are saved to pre-fill the login relay next time. Only the session token is kept after login.</p>';
    var userInput = form.querySelector('#social-add-user');
    if (userInput) userInput.focus();
}

function closeSocialAddForm() {
    var form = document.getElementById('social-connect-form');
    if (form) { form.style.display = 'none'; form.innerHTML = ''; }
}

async function saveAndConnectSocial(platform) {
    var userInput = document.getElementById('social-add-user');
    var passInput = document.getElementById('social-add-pass');
    var username = userInput ? userInput.value.trim() : '';
    var password = passInput ? passInput.value.trim() : '';
    try {
        await fetch('/api/social/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: platform, username: username, password: password })
        });
        if (!window._userSettings) window._userSettings = {};
        if (!window._userSettings.social_credentials) window._userSettings.social_credentials = {};
        window._userSettings.social_credentials[platform] = { username: username, password: password };
    } catch (_) {}
    connectSocialOnly(platform);
}

async function connectSocialOnly(platform) {
    var userInput = document.getElementById('social-add-user');
    var passInput = document.getElementById('social-add-pass');
    var username = userInput ? userInput.value.trim() : '';
    var password = passInput ? passInput.value.trim() : '';
    if (!username && !password && window._userSettings && window._userSettings.social_credentials) {
        var cached = window._userSettings.social_credentials[platform] || {};
        username = cached.username || '';
        password = cached.password || '';
    }
    closeSocialAddForm();
    var addPanel = document.getElementById('social-add-panel');
    if (addPanel) addPanel.style.display = 'none';
    var toggleBtn = document.getElementById('social-add-toggle-btn');
    if (toggleBtn) toggleBtn.textContent = '+ Add Account';
    try {
        var resp = await fetch('/api/social/connect/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: platform, username: username, password: password })
        });
        var data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Failed to start');
        openSocialLoginModal(platform, data.session_id);
    } catch (e) {
        showNotification('Connection failed: ' + e.message, 'error');
    }
}

async function testSocialExtraction(platform) {
    var input = document.getElementById('social-test-url-' + platform);
    var resultEl = document.getElementById('social-test-result-' + platform);
    if (!input || !resultEl) return;
    var url = input.value.trim();
    if (!url) { showNotification('Enter a URL to test', 'error'); return; }

    // Find the Test button next to this input and disable it
    var btn = input.parentElement && input.parentElement.querySelector('button');
    if (btn) { btn.textContent = 'Fetching\u2026'; btn.disabled = true; }

    resultEl.style.display = 'block';
    resultEl.innerHTML = '<span style="color:var(--text-muted)">Fetching\u2026</span>';

    try {
        var resp = await fetch('/api/social/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: platform, url: url })
        });
        var data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Request failed');
        var p = data.profile || {};
        if (!p || Object.keys(p).length === 0) {
            resultEl.innerHTML = '<span style="color:var(--text-muted)">No data extracted. Check the URL or try re-connecting.</span>';
            return;
        }
        var rows = [];
        var fieldMap = [
            ['title', 'Name'],
            ['description', 'Description / Bio'],
            ['about', 'About'],
            ['tagline', 'Tagline'],
            ['phone', 'Phone'],
            ['address', 'Address'],
            ['followers', 'Followers'],
            ['posts', 'Posts'],
            ['subscribers', 'Subscribers'],
            ['website', 'Website in bio'],
            ['image', 'Profile image'],
            ['url', 'Canonical URL']
        ];
        fieldMap.forEach(function(pair) {
            var val = p[pair[0]];
            if (val) rows.push(
                '<div style="margin-bottom:6px">' +
                '<span style="color:var(--text-muted);min-width:140px;display:inline-block">' + escHtml(pair[1]) + ':</span> ' +
                escHtml(String(val)) + '</div>'
            );
        });
        resultEl.innerHTML = rows.length ? rows.join('') : '<span style="color:var(--text-muted)">Fetched page but no structured fields found.</span>';
    } catch (e) {
        resultEl.innerHTML = '<span style="color:#fca5a5">Error: ' + escHtml(e.message) + '</span>';
    } finally {
        if (btn) { btn.textContent = 'Test'; btn.disabled = false; }
    }
}

function loadSocialStatus() {
    // Use cached value if available (set after connect/disconnect actions)
    if (window._userSettings && window._userSettings.social_cookies) {
        _applySocialStatus(window._userSettings.social_cookies, window._userSettings.social_credentials || {});
        return;
    }
    // Otherwise fetch from backend
    fetch('/api/get_settings')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            const socialCookies = (data.settings && data.settings.social_cookies) || {};
            const socialCreds = (data.settings && data.settings.social_credentials) || {};
            if (!window._userSettings) window._userSettings = {};
            window._userSettings.social_cookies = socialCookies;
            window._userSettings.social_credentials = socialCreds;
            _applySocialStatus(socialCookies, socialCreds);
        })
        .catch(function() {
            _applySocialStatus({}, {});
        });
}

async function socialConnect(platform) {
    var username = '', password = '';
    if (window._userSettings && window._userSettings.social_credentials) {
        var cached = window._userSettings.social_credentials[platform] || {};
        username = cached.username || '';
        password = cached.password || '';
    }
    try {
        var resp = await fetch('/api/social/connect/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: platform, username: username, password: password })
        });
        var data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Failed to start connection');
        openSocialLoginModal(platform, data.session_id);
    } catch (e) {
        showNotification('Connection failed: ' + e.message, 'error');
    }
}

async function saveSocialCredentials(platform) {
    const userInput = document.getElementById('social-user-' + platform);
    const passInput = document.getElementById('social-pass-' + platform);
    if (!userInput || !passInput) return;

    const btn = userInput.closest('.setting-group') && userInput.closest('.setting-group').querySelector('button');
    const originalText = btn ? btn.textContent : null;
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

    try {
        const saveResp = await fetch('/api/social/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, username: userInput.value, password: passInput.value })
        });
        if (!saveResp.ok) throw new Error('Server returned ' + saveResp.status);
        if (!window._userSettings) window._userSettings = {};
        if (!window._userSettings.social_credentials) window._userSettings.social_credentials = {};
        window._userSettings.social_credentials[platform] = { username: userInput.value, password: passInput.value };
        if (btn) {
            btn.textContent = 'Saved ✓';
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-success');
            setTimeout(function() {
                btn.textContent = originalText;
                btn.classList.remove('btn-success');
                btn.classList.add('btn-secondary');
                btn.disabled = false;
            }, 2000);
        }
        showNotification(platform + ' credentials saved', 'success');
    } catch (e) {
        if (btn) { btn.textContent = originalText; btn.disabled = false; }
        showNotification('Failed to save credentials: ' + e.message, 'error');
    }
}

async function socialDisconnect(platform) {
    try {
        const resp = await fetch('/api/social/disconnect/' + platform, { method: 'POST' });
        if (!resp.ok) throw new Error('Server returned ' + resp.status);
        // Remove only this platform from local cache, force re-fetch for accurate state
        if (window._userSettings) delete window._userSettings.social_cookies;
        loadSocialStatus();
        showNotification(platform + ' disconnected', 'success');
    } catch (e) {
        showNotification('Failed to disconnect: ' + e.message, 'error');
    }
}

function openSocialLoginModal(platform, sessionId) {
    const existing = document.getElementById('social-login-relay-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'social-login-relay-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border-standard);border-radius:12px;padding:20px;width:96vw;height:96vh;display:flex;flex-direction:column;overflow:hidden">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h3 style="margin:0;color:var(--text-body)">Connecting ${platform}\u2026</h3>
                <button id="social-relay-cancel" style="background:var(--surface-1);color:var(--text-body);border:none;padding:6px 12px;border-radius:6px;cursor:pointer">Cancel</button>
            </div>
            <div style="color:var(--text-dim);font-size:13px;margin-bottom:12px">
                Complete any verification steps below. Your password is not stored — only the session token will be saved.
            </div>
            <div id="social-relay-status" style="color:#fbbf24;font-size:12px;margin-bottom:10px">Logging in\u2026</div>
            <div style="border:1px solid var(--border-standard);border-radius:8px;overflow:hidden;background:var(--bg-base);flex:1;min-height:0;position:relative">
                <img id="social-relay-screenshot" style="width:100%;height:100%;object-fit:contain;display:none;cursor:crosshair" alt="browser screenshot">
                <div id="social-relay-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim)">
                    <div>Starting browser\u2026</div>
                </div>
            </div>
            <div style="margin-top:10px;color:var(--text-dim);font-size:11px">Click on the screenshot to interact. Type to enter text.</div>
        </div>`;

    document.body.appendChild(modal);

    const img = modal.querySelector('#social-relay-screenshot');
    const statusEl = modal.querySelector('#social-relay-status');
    const loadingEl = modal.querySelector('#social-relay-loading');
    const cancelBtn = modal.querySelector('#social-relay-cancel');

    // Click relay — accounts for object-fit:contain letterbox/pillarbox offset
    img.addEventListener('click', async function(e) {
        const rect = img.getBoundingClientRect();
        const naturalWidth = img.naturalWidth || 1280;
        const naturalHeight = img.naturalHeight || 800;
        const imgAspect = naturalWidth / naturalHeight;
        const containerAspect = rect.width / rect.height;
        let renderedW, renderedH, offsetX, offsetY;
        if (containerAspect > imgAspect) {
            // pillarbox: black bars left/right
            renderedH = rect.height;
            renderedW = rect.height * imgAspect;
            offsetX = (rect.width - renderedW) / 2;
            offsetY = 0;
        } else {
            // letterbox: black bars top/bottom
            renderedW = rect.width;
            renderedH = rect.width / imgAspect;
            offsetX = 0;
            offsetY = (rect.height - renderedH) / 2;
        }
        const x = Math.round((e.clientX - rect.left - offsetX) * (naturalWidth / renderedW));
        const y = Math.round((e.clientY - rect.top - offsetY) * (naturalHeight / renderedH));
        await fetch('/api/social/connect/' + sessionId + '/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'click', x: x, y: y })
        }).catch(function() {});
    });

    // Keypress relay — skip Ctrl/Meta combos (handled by paste handler)
    function keyHandler(e) {
        if (!document.getElementById('social-login-relay-modal')) return;
        if (e.ctrlKey || e.metaKey) return;
        const isPrintable = e.key.length === 1;
        fetch('/api/social/connect/' + sessionId + '/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isPrintable
                ? { type: 'type', text: e.key }
                : { type: 'key', key: e.key })
        }).catch(function() {});
    }
    document.addEventListener('keydown', keyHandler);

    // Clipboard paste relay
    function pasteHandler(e) {
        if (!document.getElementById('social-login-relay-modal')) return;
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!text) return;
        fetch('/api/social/connect/' + sessionId + '/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'type', text: text })
        }).catch(function() {});
    }
    document.addEventListener('paste', pasteHandler);

    // Screenshot poll
    const screenshotInterval = setInterval(async function() {
        try {
            const resp = await fetch('/api/social/connect/' + sessionId + '/screenshot');
            if (resp.ok) {
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const oldSrc = img.src;
                img.src = url;
                img.style.display = 'block';
                loadingEl.style.display = 'none';
                if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
            }
        } catch (_) {}
    }, 200);

    // Status poll
    const statusInterval = setInterval(async function() {
        try {
            const resp = await fetch('/api/social/connect/' + sessionId + '/status');
            const data = await resp.json();
            if (data.status === 'awaiting_input') {
                statusEl.textContent = 'Complete any verification steps in the browser above.';
                statusEl.style.color = '#fbbf24';
            } else if (data.status === 'running') {
                statusEl.textContent = 'Logging in\u2026';
            } else if (data.status === 'success') {
                statusEl.textContent = 'Connected' + (data.handle ? ' as ' + data.handle : '') + '!';
                statusEl.style.color = '#86efac';
                clearInterval(screenshotInterval);
                clearInterval(statusInterval);
                document.removeEventListener('keydown', keyHandler);
                document.removeEventListener('paste', pasteHandler);
                setTimeout(function() {
                    modal.remove();
                    // Keep settings modal open and visible
                    var settingsModal = document.getElementById('settingsModal');
                    if (settingsModal) settingsModal.style.display = 'flex';
                    // Force re-fetch real cookies from backend (dummy cache would hide token)
                    if (window._userSettings) delete window._userSettings.social_cookies;
                    loadSocialStatus();
                    showNotification(platform + ' connected successfully!', 'success');
                    // Notify social profiles plugin to refresh its card list
                    window.dispatchEvent(new CustomEvent('social-account-connected', { detail: { platform: platform } }));
                }, 2000);
                return;
            } else if (data.status === 'failed' || data.status === 'cancelled') {
                statusEl.textContent = data.status === 'cancelled' ? 'Cancelled' : 'Login failed';
                statusEl.style.color = '#fca5a5';
                clearInterval(screenshotInterval);
                clearInterval(statusInterval);
                document.removeEventListener('keydown', keyHandler);
                document.removeEventListener('paste', pasteHandler);
                setTimeout(function() { modal.remove(); }, 3000);
                return;
            }
        } catch (_) {}
    }, 1500);

    cancelBtn.addEventListener('click', async function() {
        clearInterval(screenshotInterval);
        clearInterval(statusInterval);
        document.removeEventListener('keydown', keyHandler);
        document.removeEventListener('paste', pasteHandler);
        await fetch('/api/social/connect/' + sessionId + '/cancel', { method: 'POST' }).catch(function() {});
        modal.remove();
    });
}

// Apply custom CSS to the page
function applyCustomCSS() {
    // Remove existing custom CSS if present
    const existingStyle = document.getElementById('custom-user-styles');
    if (existingStyle) {
        existingStyle.remove();
    }

    // Get custom CSS from settings
    const customCSS = currentSettings.customCSS || '';

    // Only inject if there's CSS to apply
    if (customCSS.trim()) {
        const styleElement = document.createElement('style');
        styleElement.id = 'custom-user-styles';
        styleElement.textContent = customCSS;
        document.head.appendChild(styleElement);
        console.log('Custom CSS applied');
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const tabBar = document.querySelector('.settings-tabs');
    if (tabBar) {
        tabBar.addEventListener('wheel', function(e) {
            if (e.deltaY !== 0) {
                e.preventDefault();
                tabBar.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }
});