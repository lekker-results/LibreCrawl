import threading
import time
import csv
import json
import xml.etree.ElementTree as ET
import uuid
import webbrowser
import argparse
import secrets
import string
import os
from io import StringIO
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_compress import Compress
from functools import wraps
from src.crawler import WebCrawler
from src.settings_manager import SettingsManager
from src.auth_db import init_db, create_user, authenticate_user, get_user_by_id, log_guest_crawl, get_guest_crawls_last_24h, verify_user, set_user_tier, create_verification_token, verify_token, get_user_by_email, create_api_key, validate_api_key, list_api_keys, revoke_api_key
from src.email_service import send_verification_email, send_welcome_email

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# Parse command line arguments
parser = argparse.ArgumentParser(description='LibreCrawl - SEO Spider Tool')
parser.add_argument('--local', '-l', action='store_true',
                    help='Run in local mode (all users get admin tier, no rate limits)')
parser.add_argument('--disable-register', '-dr', action='store_true',
                    help='Disable new user registrations')
parser.add_argument('--disable-guest', '-dg', action='store_true',
                    help='Disable guest login')
args = parser.parse_args()

LOCAL_MODE = args.local
DISABLE_REGISTER = args.disable_register
DISABLE_GUEST = args.disable_guest or os.getenv('DISABLE_GUEST', '').lower() in ('true', '1', 'yes')

app = Flask(__name__, template_folder='web/templates', static_folder='web/static')
app.secret_key = 'librecrawl-secret-key-change-in-production'  # TODO: Use environment variable in production

# Enable compression for all responses
Compress(app)

# Initialize database on startup
init_db()

def generate_random_password(length=16):
    """Generate a random password with letters, digits, and symbols"""
    alphabet = string.ascii_letters + string.digits + string.punctuation
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def auto_login_local_mode():
    """Auto-login for local mode - creates or logs into 'local' admin account"""
    import sqlite3
    try:
        conn = sqlite3.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'users.db'))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Check if 'local' user exists
        cursor.execute('SELECT id, username, tier FROM users WHERE username = ?', ('local',))
        user = cursor.fetchone()

        if user:
            # User exists, just log them in
            session['user_id'] = user['id']
            session['username'] = user['username']
            session['tier'] = 'admin'
            session.permanent = True
            print(f"Auto-logged in as existing 'local' user (ID: {user['id']})")
        else:
            # Create new local user with random password
            random_password = generate_random_password()
            from src.auth_db import hash_password
            password_hash = hash_password(random_password)

            cursor.execute('''
                INSERT INTO users (username, email, password_hash, verified, tier)
                VALUES (?, ?, ?, 1, 'admin')
            ''', ('local', 'local@localhost', password_hash))
            conn.commit()

            user_id = cursor.lastrowid

            # Log in the new user
            session['user_id'] = user_id
            session['username'] = 'local'
            session['tier'] = 'admin'
            session.permanent = True

            print(f"Created and auto-logged in as new 'local' admin user (ID: {user_id})")
            print(f"Generated password: {random_password}")

        conn.close()
        return True
    except Exception as e:
        print(f"Error in auto_login_local_mode: {e}")
        return False

if LOCAL_MODE:
    print("=" * 60)
    print("LOCAL MODE ENABLED")
    print("All users will have admin tier access")
    print("No rate limits or tier restrictions")
    print("Auto-login enabled with 'local' admin account")
    print("=" * 60)

if DISABLE_REGISTER:
    print("=" * 60)
    print("REGISTRATION DISABLED")
    print("New user registrations are not allowed")
    print("=" * 60)

if DISABLE_GUEST:
    print("=" * 60)
    print("GUEST MODE DISABLED")
    print("Guest login is not allowed")
    print("=" * 60)

def get_client_ip():
    """Get the real client IP address, checking Cloudflare headers first"""
    # Check Cloudflare header first
    if 'CF-Connecting-IP' in request.headers:
        return request.headers['CF-Connecting-IP']
    # Check other common proxy headers
    if 'X-Forwarded-For' in request.headers:
        # X-Forwarded-For can contain multiple IPs, take the first one
        return request.headers['X-Forwarded-For'].split(',')[0].strip()
    if 'X-Real-IP' in request.headers:
        return request.headers['X-Real-IP']
    # Fall back to direct connection IP
    return request.remote_addr

def login_required(f):
    """Decorator to require login for routes"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # In local mode, auto-login if not already logged in
        if LOCAL_MODE and 'user_id' not in session:
            auto_login_local_mode()
        elif 'user_id' not in session:
            # Not in local mode and not logged in
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Authentication required'}), 401
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated_function

# Multi-tenant crawler instances
crawler_instances = {}  # session_id -> {'crawler': WebCrawler, 'settings': SettingsManager, 'last_accessed': datetime}
instances_lock = threading.Lock()

def get_or_create_crawler():
    """Get or create a crawler instance for the current session"""
    # Get or create session ID
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())

    session_id = session['session_id']
    user_id = session.get('user_id')  # Get user_id from session
    tier = session.get('tier', 'guest')  # Get tier from session

    with instances_lock:
        # Check if crawler exists for this session
        if session_id not in crawler_instances:
            print(f"Creating new crawler instance for session: {session_id}, user: {user_id}, tier: {tier}")
            crawler_instances[session_id] = {
                'crawler': WebCrawler(),
                'settings': SettingsManager(session_id=session_id, user_id=user_id, tier=tier),  # Per-user settings
                'last_accessed': datetime.now()
            }
        else:
            # Update last accessed time
            crawler_instances[session_id]['last_accessed'] = datetime.now()

        return crawler_instances[session_id]['crawler']

def get_session_settings():
    """Get the settings manager for the current session"""
    # Get or create session ID
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())

    session_id = session['session_id']
    user_id = session.get('user_id')  # Get user_id from session
    tier = session.get('tier', 'guest')  # Get tier from session

    with instances_lock:
        # Create instance if it doesn't exist
        if session_id not in crawler_instances:
            print(f"Creating new settings instance for session: {session_id}, user: {user_id}, tier: {tier}")
            crawler_instances[session_id] = {
                'crawler': WebCrawler(),
                'settings': SettingsManager(session_id=session_id, user_id=user_id, tier=tier),
                'last_accessed': datetime.now()
            }
        else:
            # Update last accessed time
            crawler_instances[session_id]['last_accessed'] = datetime.now()

        return crawler_instances[session_id]['settings']

def cleanup_old_instances():
    """Remove crawler instances that haven't been accessed in 1 hour"""
    timeout = timedelta(hours=1)
    now = datetime.now()

    with instances_lock:
        sessions_to_remove = []
        for session_id, instance_data in crawler_instances.items():
            if now - instance_data['last_accessed'] > timeout:
                sessions_to_remove.append(session_id)

        for session_id in sessions_to_remove:
            print(f"Cleaning up crawler instance for session: {session_id}")
            # Stop any running crawls
            try:
                crawler_instances[session_id]['crawler'].stop_crawl()
            except:
                pass
            del crawler_instances[session_id]

        if sessions_to_remove:
            print(f"Cleaned up {len(sessions_to_remove)} inactive crawler instances")

def start_cleanup_thread():
    """Start background thread to cleanup old instances"""
    def cleanup_loop():
        while True:
            time.sleep(300)  # Check every 5 minutes
            try:
                cleanup_old_instances()
                # Clean up stale research jobs (older than 30 minutes)
                _cleanup_research_jobs()
            except Exception as e:
                print(f"Error in cleanup thread: {e}")

    cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
    cleanup_thread.start()
    print("Started crawler instance cleanup thread")

def generate_csv_export(urls, fields):
    """Generate CSV export content"""
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()

    for url_data in urls:
        row = {}
        for field in fields:
            value = url_data.get(field, '')

            # Handle complex data types for CSV
            if field == 'analytics' and isinstance(value, dict):
                analytics_list = []
                if value.get('gtag') or value.get('ga4_id'): analytics_list.append('GA4')
                if value.get('google_analytics'): analytics_list.append('GA')
                if value.get('gtm_id'): analytics_list.append('GTM')
                if value.get('facebook_pixel'): analytics_list.append('FB')
                if value.get('hotjar'): analytics_list.append('HJ')
                if value.get('mixpanel'): analytics_list.append('MP')
                row[field] = ', '.join(analytics_list)
            elif field == 'og_tags' and isinstance(value, dict):
                row[field] = f"{len(value)} tags" if value else ''
            elif field == 'twitter_tags' and isinstance(value, dict):
                row[field] = f"{len(value)} tags" if value else ''
            elif field == 'json_ld' and isinstance(value, list):
                row[field] = f"{len(value)} scripts" if value else ''
            elif field == 'images' and isinstance(value, list):
                row[field] = f"{len(value)} images" if value else ''
            elif field == 'internal_links' and isinstance(value, (int, float)):
                row[field] = f"{int(value)} internal links" if value else '0 internal links'
            elif field == 'external_links' and isinstance(value, (int, float)):
                row[field] = f"{int(value)} external links" if value else '0 external links'
            elif field == 'h2' and isinstance(value, list):
                row[field] = ', '.join(value[:3]) + ('...' if len(value) > 3 else '')
            elif field == 'h3' and isinstance(value, list):
                row[field] = ', '.join(value[:3]) + ('...' if len(value) > 3 else '')
            elif isinstance(value, (dict, list)):
                row[field] = str(value)
            else:
                row[field] = value

        writer.writerow(row)

    return output.getvalue()

def generate_json_export(urls, fields):
    """Generate JSON export content"""
    filtered_urls = []
    for url_data in urls:
        filtered_data = {}
        for field in fields:
            value = url_data.get(field, '')
            # Keep complex data structures intact in JSON
            filtered_data[field] = value
        filtered_urls.append(filtered_data)

    return json.dumps({
        'export_date': time.strftime('%Y-%m-%d %H:%M:%S'),
        'total_urls': len(filtered_urls),
        'fields': fields,
        'data': filtered_urls
    }, indent=2, default=str)

def generate_xml_export(urls, fields):
    """Generate XML export content"""
    root = ET.Element('librecrawl_export')
    root.set('export_date', time.strftime('%Y-%m-%d %H:%M:%S'))
    root.set('total_urls', str(len(urls)))

    urls_element = ET.SubElement(root, 'urls')

    for url_data in urls:
        url_element = ET.SubElement(urls_element, 'url')
        for field in fields:
            field_element = ET.SubElement(url_element, field)
            field_element.text = str(url_data.get(field, ''))

    return ET.tostring(root, encoding='unicode')

def generate_links_csv_export(links):
    """Generate CSV export for links data"""
    output = StringIO()
    fieldnames = ['source_url', 'target_url', 'anchor_text', 'is_internal', 'target_domain', 'target_status', 'placement']
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    for link in links:
        row = {
            'source_url': link.get('source_url', ''),
            'target_url': link.get('target_url', ''),
            'anchor_text': link.get('anchor_text', ''),
            'is_internal': 'Yes' if link.get('is_internal') else 'No',
            'target_domain': link.get('target_domain', ''),
            'target_status': link.get('target_status', 'Not crawled'),
            'placement': link.get('placement', 'body')
        }
        writer.writerow(row)

    return output.getvalue()

def generate_links_json_export(links):
    """Generate JSON export for links data"""
    return json.dumps(links, indent=2)

def filter_issues_by_exclusion_patterns(issues, exclusion_patterns):
    """Filter issues based on exclusion patterns (applies current settings to loaded crawls)"""
    from fnmatch import fnmatch
    from urllib.parse import urlparse

    if not exclusion_patterns:
        return issues

    filtered_issues = []

    for issue in issues:
        url = issue.get('url', '')
        parsed = urlparse(url)
        path = parsed.path

        # Check if URL matches any exclusion pattern
        should_exclude = False
        for pattern in exclusion_patterns:
            if not pattern.strip() or pattern.strip().startswith('#'):
                continue

            if '*' in pattern:
                if fnmatch(path, pattern):
                    should_exclude = True
                    break
            elif path == pattern or path.startswith(pattern.rstrip('*')):
                should_exclude = True
                break

        if not should_exclude:
            filtered_issues.append(issue)

    return filtered_issues

def generate_issues_csv_export(issues):
    """Generate CSV export for issues data"""
    output = StringIO()
    fieldnames = ['url', 'type', 'category', 'issue', 'details']
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    for issue in issues:
        row = {
            'url': issue.get('url', ''),
            'type': issue.get('type', ''),
            'category': issue.get('category', ''),
            'issue': issue.get('issue', ''),
            'details': issue.get('details', '')
        }
        writer.writerow(row)

    return output.getvalue()

def generate_issues_json_export(issues):
    """Generate JSON export for issues data"""
    # Group issues by URL for better organization
    issues_by_url = {}
    for issue in issues:
        url = issue.get('url', '')
        if url not in issues_by_url:
            issues_by_url[url] = []
        issues_by_url[url].append({
            'type': issue.get('type', ''),
            'category': issue.get('category', ''),
            'issue': issue.get('issue', ''),
            'details': issue.get('details', '')
        })

    return json.dumps({
        'export_date': time.strftime('%Y-%m-%d %H:%M:%S'),
        'total_issues': len(issues),
        'total_urls_with_issues': len(issues_by_url),
        'issues_by_url': issues_by_url,
        'all_issues': issues
    }, indent=2)

@app.route('/login')
def login_page():
    # In local mode, auto-login and redirect to index
    if LOCAL_MODE:
        auto_login_local_mode()
        return redirect(url_for('index'))
    # Redirect to app if already logged in
    if 'user_id' in session:
        return redirect(url_for('index'))
    return render_template('login.html', registration_disabled=DISABLE_REGISTER, guest_disabled=DISABLE_GUEST)

@app.route('/register')
def register_page():
    # Redirect to app if already logged in
    if 'user_id' in session:
        return redirect(url_for('index'))
    return render_template('register.html', registration_disabled=DISABLE_REGISTER)

@app.route('/verify')
def verify_email():
    """Email verification endpoint"""
    token = request.args.get('token')

    if not token:
        return render_template('verification_result.html',
                             success=False,
                             message='Invalid verification link',
                             app_source='main')

    # Verify the token
    success, message, app_source, user_email = verify_token(token)

    # Send welcome email if successful
    if success and user_email:
        try:
            user = get_user_by_email(user_email)
            if user:
                send_welcome_email(user_email, user['username'], app_source or 'main')
        except Exception as e:
            print(f"Error sending welcome email: {e}")

    # Determine redirect URL based on app_source
    redirect_url = None
    if success:
        if app_source == 'workshop':
            redirect_url = os.getenv('WORKSHOP_APP_URL', 'https://workshop.librecrawl.com')
        else:
            redirect_url = url_for('login_page')

    return render_template('verification_result.html',
                         success=success,
                         message=message,
                         app_source=app_source or 'main',
                         redirect_url=redirect_url)

@app.route('/api/register', methods=['POST'])
def register():
    # Check if registration is disabled
    if DISABLE_REGISTER:
        return jsonify({'success': False, 'message': 'Registration is currently disabled'})

    data = request.get_json()
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')

    success, message, user_id = create_user(username, email, password)

    # In local mode, auto-verify and set to admin tier
    if success and LOCAL_MODE:
        try:
            from src.auth_db import verify_user, set_user_tier
            # Get the user that was just created
            import sqlite3
            conn = sqlite3.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'users.db'))
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('SELECT id FROM users WHERE username = ?', (username,))
            user = cursor.fetchone()
            conn.close()

            if user:
                verify_user(user['id'])
                set_user_tier(user['id'], 'admin')
                message = 'Account created and verified! You have admin access in local mode.'
        except Exception as e:
            print(f"Error during local mode auto-verification: {e}")
            # Don't fail the registration, just log the error
            # The account is still created successfully
    elif success:
        # Not in local mode - send verification email
        is_resend = (message == 'resend')
        try:
            # Create verification token
            token = create_verification_token(user_id, app_source='main')
            if token:
                # Send verification email
                email_success, email_message = send_verification_email(
                    email, username, token, app_source='main', is_resend=is_resend
                )
                if email_success:
                    if is_resend:
                        message = 'A verification email was already sent to this address. We\'ve updated your account details and sent a new verification link.'
                    else:
                        message = 'Registration successful! Please check your email to verify your account.'
                else:
                    message = 'Account created, but we could not send the verification email. Please contact support.'
                    print(f"Email error: {email_message}")
            else:
                message = 'Account created, but verification token generation failed. Please contact support.'
        except Exception as e:
            print(f"Error sending verification email: {e}")
            message = 'Account created, but we could not send the verification email. Please contact support.'

    return jsonify({'success': success, 'message': message})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    success, message, user_data = authenticate_user(username, password)

    if success:
        session['user_id'] = user_data['id']
        session['username'] = user_data['username']
        # In local mode, always give admin tier
        session['tier'] = 'admin' if LOCAL_MODE else user_data['tier']
        session.permanent = True  # Remember login

    return jsonify({'success': success, 'message': message})

@app.route('/api/guest-login', methods=['POST'])
def guest_login():
    """Login as a guest user (no account required, limited to 3 crawls/24h)"""
    if DISABLE_GUEST:
        return jsonify({'success': False, 'message': 'Guest login is disabled'})

    # Create a guest session with no user_id but with tier='guest'
    # In local mode, guests also get admin tier
    session['user_id'] = None
    session['username'] = 'Guest'
    session['tier'] = 'admin' if LOCAL_MODE else 'guest'
    session.permanent = False  # Don't persist guest sessions

    return jsonify({'success': True, 'message': 'Logged in as guest'})

@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})

@app.route('/api/user/info')
@login_required
def user_info():
    """Get current user info including tier"""
    from src.auth_db import get_crawls_last_24h
    user_id = session.get('user_id')
    tier = session.get('tier', 'guest')
    username = session.get('username')

    # Get crawl count
    crawls_today = 0
    if tier == 'guest':
        # For guests, count from IP address
        client_ip = get_client_ip()
        crawls_today = get_guest_crawls_last_24h(client_ip)
    else:
        # For registered users, count from database
        crawls_today = get_crawls_last_24h(user_id)

    return jsonify({
        'success': True,
        'user': {
            'id': user_id,
            'username': username,
            'tier': tier,
            'crawls_today': crawls_today,
            'crawls_remaining': max(0, 3 - crawls_today) if tier == 'guest' else -1
        }
    })

@app.route('/')
def index():
    # In local mode, auto-login if not already logged in
    if LOCAL_MODE and 'user_id' not in session:
        auto_login_local_mode()
    elif 'user_id' not in session:
        # Not in local mode and not logged in, redirect to login
        return redirect(url_for('login_page'))
    return render_template('index.html')

@app.route('/dashboard')
@login_required
def dashboard():
    """Crawl history dashboard"""
    return render_template('dashboard.html')

@app.route('/debug/memory')
@login_required
def debug_memory_page():
    """Debug page with nice UI for memory monitoring"""
    return render_template('debug_memory.html')

@app.route('/api/start_crawl', methods=['POST'])
@login_required
def start_crawl():
    from src.auth_db import get_crawls_last_24h, log_crawl_start

    data = request.get_json()
    url = data.get('url')

    if not url:
        return jsonify({'success': False, 'error': 'URL is required'})

    user_id = session.get('user_id')
    session_id = session.get('session_id')
    tier = session.get('tier', 'guest')

    # Check guest limits (IP-based) - skip in local mode
    if tier == 'guest' and not LOCAL_MODE:
        client_ip = get_client_ip()
        crawls_from_ip = get_guest_crawls_last_24h(client_ip)

        if crawls_from_ip >= 3:
            return jsonify({
                'success': False,
                'error': 'Guest limit reached: 3 crawls per 24 hours from your IP address. Please register for unlimited crawls.'
            })

        # Log this guest crawl
        log_guest_crawl(client_ip)

    # Get or create crawler for this session
    crawler = get_or_create_crawler()
    settings_manager = get_session_settings()

    # Apply current settings to crawler before starting
    try:
        crawler_config = settings_manager.get_crawler_config()
        crawler.update_config(crawler_config)
    except Exception as e:
        print(f"Warning: Could not apply settings: {e}")

    # Pass user_id and session_id for database persistence
    success, message = crawler.start_crawl(url, user_id=user_id, session_id=session_id)

    # Store crawl_id in session
    if success and crawler.crawl_id:
        session['current_crawl_id'] = crawler.crawl_id
        # Also log to old crawl_history for compatibility
        log_crawl_start(user_id, url)

    return jsonify({'success': success, 'message': message, 'crawl_id': crawler.crawl_id})

@app.route('/api/stop_crawl', methods=['POST'])
@login_required
def stop_crawl():
    crawler = get_or_create_crawler()
    success, message = crawler.stop_crawl()
    return jsonify({'success': success, 'message': message})

@app.route('/api/crawl_status')
@login_required
def crawl_status():
    crawler = get_or_create_crawler()
    settings_manager = get_session_settings()

    # Check for incremental update parameters
    url_since = request.args.get('url_since', type=int)
    link_since = request.args.get('link_since', type=int)
    issue_since = request.args.get('issue_since', type=int)

    # Get full status data
    status_data = crawler.get_status()

    # Ensure baseUrl is in stats (needed for UI to work correctly)
    if crawler.base_url and 'stats' in status_data:
        status_data['stats']['baseUrl'] = crawler.base_url

    # Check if we need to force a full refresh (after loading from DB)
    force_full = session.pop('force_full_refresh', False)

    # If incremental parameters provided AND not forcing full refresh, slice the arrays
    if not force_full:
        if url_since is not None:
            status_data['urls'] = status_data.get('urls', [])[url_since:]
        if link_since is not None:
            status_data['links'] = status_data.get('links', [])[link_since:]
        if issue_since is not None:
            status_data['issues'] = status_data.get('issues', [])[issue_since:]

    # Apply current issue exclusion patterns to displayed issues
    issues = status_data.get('issues', [])
    if issues:
        current_settings = settings_manager.get_settings()
        exclusion_patterns_text = current_settings.get('issueExclusionPatterns', '')
        exclusion_patterns = [p.strip() for p in exclusion_patterns_text.split('\n') if p.strip()]
        filtered_issues = filter_issues_by_exclusion_patterns(issues, exclusion_patterns)
        status_data['issues'] = filtered_issues

    return jsonify(status_data)

@app.route('/api/visualization_data')
@login_required
def visualization_data():
    """Get graph data for site structure visualization"""
    try:
        crawler = get_or_create_crawler()
        status_data = crawler.get_status()

        # Get URLs from the status data
        crawled_pages = status_data.get('urls', [])
        all_links = status_data.get('links', [])

        # Build nodes and edges for the graph
        nodes = []
        edges = []
        url_to_id = {}

        # Create nodes from crawled pages (limit to prevent lag)
        max_nodes = 500  # Optimization: limit nodes for performance
        pages_to_visualize = crawled_pages[:max_nodes]

        for idx, page in enumerate(pages_to_visualize):
            url = page.get('url', '')
            status_code = page.get('status_code', 0)

            # Assign color based on status code
            if 200 <= status_code < 300:
                color = '#10b981'  # Green for 2xx
            elif 300 <= status_code < 400:
                color = '#3b82f6'  # Blue for 3xx
            elif 400 <= status_code < 500:
                color = '#f59e0b'  # Orange for 4xx
            elif 500 <= status_code < 600:
                color = '#ef4444'  # Red for 5xx
            else:
                color = '#6b7280'  # Gray for other

            # Create node
            node = {
                'data': {
                    'id': f'node-{idx}',
                    'label': url.split('/')[-1] or url.split('//')[-1],  # Use last path segment or domain
                    'url': url,
                    'status_code': status_code,
                    'title': page.get('title', ''),
                    'color': color,
                    'size': 30 if idx == 0 else 20,  # Make root node larger
                    'depth': page.get('depth', 0)
                }
            }
            nodes.append(node)
            url_to_id[url] = f'node-{idx}'

        # Create edges from links data
        # Links are stored as: {'source_url': url, 'target_url': url, 'is_internal': bool, ...}
        edges_set = set()  # Use set to avoid duplicate edges
        for link in all_links:
            if link.get('is_internal'):  # Only use internal links
                source_url = link.get('source_url', '')
                target_url = link.get('target_url', '')

                source_id = url_to_id.get(source_url)
                target_id = url_to_id.get(target_url)

                if source_id and target_id and source_id != target_id:
                    edge_key = f'{source_id}-{target_id}'
                    if edge_key not in edges_set:
                        edges_set.add(edge_key)
                        edge = {
                            'data': {
                                'id': f'edge-{edge_key}',
                                'source': source_id,
                                'target': target_id
                            }
                        }
                        edges.append(edge)

        return jsonify({
            'success': True,
            'nodes': nodes,
            'edges': edges,
            'total_pages': len(crawled_pages),
            'visualized_pages': len(nodes),
            'truncated': len(crawled_pages) > max_nodes
        })

    except Exception as e:
        print(f"Error generating visualization data: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e),
            'nodes': [],
            'edges': []
        })

@app.route('/api/debug/memory')
@login_required
def debug_memory():
    """Debug endpoint showing memory stats for all active crawler instances"""
    from src.core.memory_profiler import MemoryProfiler

    with instances_lock:
        memory_stats = {
            'total_instances': len(crawler_instances),
            'instances': []
        }

        for session_id, instance_data in crawler_instances.items():
            crawler = instance_data['crawler']
            stats = crawler.memory_monitor.get_stats()

            # Get accurate data sizes
            data_sizes = MemoryProfiler.get_crawler_data_size(
                crawler.crawl_results,
                crawler.link_manager.all_links if crawler.link_manager else [],
                crawler.issue_detector.detected_issues if crawler.issue_detector else []
            )

            memory_stats['instances'].append({
                'session_id': session_id[:8] + '...',  # Truncate for privacy
                'last_accessed': instance_data['last_accessed'].isoformat(),
                'urls_crawled': len(crawler.crawl_results),
                'memory': stats,
                'data_sizes': data_sizes
            })

        return jsonify(memory_stats)

@app.route('/api/debug/memory/profile')
@login_required
def debug_memory_profile():
    """Detailed memory profiling - what's actually using the RAM"""
    from src.core.memory_profiler import MemoryProfiler

    with instances_lock:
        profiles = []

        for session_id, instance_data in crawler_instances.items():
            crawler = instance_data['crawler']

            # Get object breakdown
            breakdown = MemoryProfiler.get_object_memory_breakdown()

            # Get crawler-specific data sizes
            data_sizes = MemoryProfiler.get_crawler_data_size(
                crawler.crawl_results,
                crawler.link_manager.all_links if crawler.link_manager else [],
                crawler.issue_detector.detected_issues if crawler.issue_detector else []
            )

            profiles.append({
                'session_id': session_id[:8] + '...',
                'urls_crawled': len(crawler.crawl_results),
                'object_breakdown': breakdown,
                'data_sizes': data_sizes
            })

        return jsonify({
            'total_instances': len(crawler_instances),
            'profiles': profiles
        })

@app.route('/api/filter_issues', methods=['POST'])
@login_required
def filter_issues():
    try:
        data = request.get_json()
        issues = data.get('issues', [])
        settings_manager = get_session_settings()

        # Get current exclusion patterns
        current_settings = settings_manager.get_settings()
        exclusion_patterns_text = current_settings.get('issueExclusionPatterns', '')
        exclusion_patterns = [p.strip() for p in exclusion_patterns_text.split('\n') if p.strip()]

        # Filter issues
        filtered_issues = filter_issues_by_exclusion_patterns(issues, exclusion_patterns)

        return jsonify({'success': True, 'issues': filtered_issues})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/get_settings')
@login_required
def get_settings():
    try:
        settings_manager = get_session_settings()
        settings = settings_manager.get_settings()
        return jsonify({'success': True, 'settings': settings})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/save_settings', methods=['POST'])
@login_required
def save_settings():
    try:
        data = request.get_json()
        settings_manager = get_session_settings()
        success, message = settings_manager.save_settings(data)
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/reset_settings', methods=['POST'])
@login_required
def reset_settings():
    try:
        settings_manager = get_session_settings()
        success, message = settings_manager.reset_settings()
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update_crawler_settings', methods=['POST'])
@login_required
def update_crawler_settings():
    try:
        crawler = get_or_create_crawler()
        settings_manager = get_session_settings()
        # Get current settings and update crawler configuration
        crawler_config = settings_manager.get_crawler_config()
        crawler.update_config(crawler_config)
        return jsonify({'success': True, 'message': 'Crawler settings updated'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/pause_crawl', methods=['POST'])
@login_required
def pause_crawl():
    try:
        crawler = get_or_create_crawler()
        success, message = crawler.pause_crawl()
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/resume_crawl', methods=['POST'])
@login_required
def resume_crawl():
    try:
        crawler = get_or_create_crawler()
        success, message = crawler.resume_crawl()
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/crawls/list')
@login_required
def list_crawls():
    """Get all crawls for current user"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import get_user_crawls, get_crawl_count

        limit = request.args.get('limit', 50, type=int)
        offset = request.args.get('offset', 0, type=int)
        status_filter = request.args.get('status')

        crawls = get_user_crawls(user_id, limit=limit, offset=offset, status_filter=status_filter)
        total_count = get_crawl_count(user_id)

        return jsonify({
            'success': True,
            'crawls': crawls,
            'total': total_count
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/crawls/<int:crawl_id>')
@login_required
def get_crawl(crawl_id):
    """Get complete crawl data by ID"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import get_crawl_by_id, load_crawled_urls, load_crawl_links, load_crawl_issues

        # Get crawl metadata
        crawl = get_crawl_by_id(crawl_id)
        if not crawl:
            return jsonify({'success': False, 'error': 'Crawl not found'}), 404

        # Check ownership (guests have user_id = None)
        if user_id and crawl.get('user_id') != user_id:
            return jsonify({'success': False, 'error': 'Unauthorized'}), 403

        # Load all data
        urls = load_crawled_urls(crawl_id)
        links = load_crawl_links(crawl_id)
        issues = load_crawl_issues(crawl_id)

        return jsonify({
            'success': True,
            'crawl': crawl,
            'urls': urls,
            'links': links,
            'issues': issues
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/crawls/<int:crawl_id>/load', methods=['POST'])
@login_required
def load_crawl_into_session(crawl_id):
    """Load a historical crawl into the current session"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import get_crawl_by_id, load_crawled_urls, load_crawl_links, load_crawl_issues

        # Get crawl metadata
        crawl = get_crawl_by_id(crawl_id)
        if not crawl:
            return jsonify({'success': False, 'error': 'Crawl not found'}), 404

        # Check ownership
        if user_id and crawl.get('user_id') != user_id:
            return jsonify({'success': False, 'error': 'Unauthorized'}), 403

        # Get current crawler instance
        crawler = get_or_create_crawler()

        # Stop any running crawl
        if crawler.is_running:
            crawler.stop_crawl()

        # Load all data from database
        urls = load_crawled_urls(crawl_id)
        links = load_crawl_links(crawl_id)
        issues = load_crawl_issues(crawl_id)

        # Inject into current crawler instance
        with crawler.results_lock:
            crawler.crawl_results = urls
            crawler.stats['crawled'] = len(urls)
            crawler.stats['discovered'] = len(urls)
            crawler.base_url = crawl['base_url']
            crawler.base_domain = crawl['base_domain']

        # Load links into link manager
        if crawler.link_manager:
            crawler.link_manager.all_links = links
            # Rebuild links_set
            crawler.link_manager.links_set.clear()
            for link in links:
                link_key = f"{link['source_url']}|{link['target_url']}"
                crawler.link_manager.links_set.add(link_key)

        # Load issues into issue detector
        if crawler.issue_detector:
            crawler.issue_detector.detected_issues = issues

        # Set Flask session flag for force full refresh
        session['force_full_refresh'] = True

        return jsonify({
            'success': True,
            'message': f'Loaded {len(urls)} URLs, {len(links)} links, {len(issues)} issues',
            'urls_count': len(urls),
            'links_count': len(links),
            'issues_count': len(issues),
            'should_refresh_ui': True
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/crawls/<int:crawl_id>/resume', methods=['POST'])
@login_required
def resume_crawl_endpoint(crawl_id):
    """Resume an interrupted crawl"""
    try:
        user_id = session.get('user_id')
        session_id = session.get('session_id')

        # Get crawler for this session
        crawler = get_or_create_crawler()

        # Resume from database
        success, message = crawler.resume_from_database(crawl_id, user_id=user_id, session_id=session_id)

        if success:
            session['current_crawl_id'] = crawl_id

        return jsonify({'success': success, 'message': message})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/crawls/<int:crawl_id>/delete', methods=['DELETE'])
@login_required
def delete_crawl_endpoint(crawl_id):
    """Delete a crawl and all associated data"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import delete_crawl, get_crawl_by_id

        # Verify ownership
        crawl = get_crawl_by_id(crawl_id)
        if not crawl:
            return jsonify({'success': False, 'error': 'Crawl not found'}), 404

        if user_id and crawl.get('user_id') != user_id:
            return jsonify({'success': False, 'error': 'Unauthorized'}), 403

        success = delete_crawl(crawl_id)
        return jsonify({'success': success, 'message': 'Crawl deleted successfully' if success else 'Failed to delete crawl'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/crawls/<int:crawl_id>/archive', methods=['POST'])
@login_required
def archive_crawl(crawl_id):
    """Archive crawl (mark as archived but keep data)"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import set_crawl_status, get_crawl_by_id

        # Verify ownership
        crawl = get_crawl_by_id(crawl_id)
        if not crawl:
            return jsonify({'success': False, 'error': 'Crawl not found'}), 404

        if user_id and crawl.get('user_id') != user_id:
            return jsonify({'success': False, 'error': 'Unauthorized'}), 403

        success = set_crawl_status(crawl_id, 'archived')
        return jsonify({'success': success, 'message': 'Crawl archived successfully' if success else 'Failed to archive crawl'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/crawls/stats')
@login_required
def crawl_stats():
    """Get statistics about user's crawls"""
    try:
        user_id = session.get('user_id')
        from src.crawl_db import get_crawl_count, get_database_size_mb
        import sqlite3

        # Get counts by status
        conn = sqlite3.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'users.db'))
        cursor = conn.cursor()

        cursor.execute('''
            SELECT status, COUNT(*) as count
            FROM crawls
            WHERE user_id = ?
            GROUP BY status
        ''', (user_id,))

        status_counts = {row[0]: row[1] for row in cursor.fetchall()}
        conn.close()

        return jsonify({
            'success': True,
            'total_crawls': get_crawl_count(user_id),
            'by_status': status_counts,
            'database_size_mb': get_database_size_mb()
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/keywords', methods=['GET', 'POST'])
@login_required
def api_keywords():
    """Return keyword analysis for the current crawl session or POSTed data"""
    from src.keyword_extractor import extract_keywords
    from urllib.parse import urlparse

    try:
        # POST: client sends local crawl data (e.g. viewing a saved crawl not loaded into session)
        if request.method == 'POST':
            body = request.get_json()
            urls = body.get('urls', [])
            links = body.get('links', [])
            limit = body.get('limit', 50)
            fmt = 'json'
            min_score = 0
            domain = urlparse(urls[0]['url']).netloc if urls and urls[0].get('url') else ''
        else:
            limit = request.args.get('limit', 50, type=int)
            fmt = request.args.get('format', 'json')
            min_score = request.args.get('min_score', 0, type=float)

            crawler = get_or_create_crawler()
            status_data = crawler.get_status()
            urls = status_data.get('urls', [])
            links = status_data.get('links', [])
            domain = urlparse(crawler.base_url).netloc if crawler.base_url else ''

        if not urls:
            return jsonify({'domain': '', 'analyzed_at': '', 'pages_analyzed': 0, 'keywords': []})
        keywords = extract_keywords(urls, links, limit=limit)

        if min_score > 0:
            keywords = [k for k in keywords if k['score'] >= min_score]

        # Add rank
        for i, kw in enumerate(keywords):
            kw['rank'] = i + 1

        if fmt == 'csv':
            output = StringIO()
            writer = csv.writer(output)
            writer.writerow(['Keyword', 'Score', 'Frequency', 'Pages Found On', 'Source Fields', 'Search Volume', 'Competition'])
            for kw in keywords:
                writer.writerow([
                    kw['keyword'], kw['score'], kw['frequency'],
                    kw['pages'], '; '.join(kw['sources']), '', ''
                ])
            csv_content = output.getvalue()
            from flask import Response
            filename = f"keywords-{domain}-{datetime.now().strftime('%Y%m%d')}.csv"
            return Response(
                csv_content,
                mimetype='text/csv',
                headers={'Content-Disposition': f'attachment; filename="{filename}"'}
            )

        return jsonify({
            'domain': domain,
            'analyzed_at': datetime.now().isoformat(),
            'pages_analyzed': len(urls),
            'keywords': keywords
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/keywords/<int:crawl_id>')
@login_required
def api_keywords_by_crawl(crawl_id):
    """Return keyword analysis for a specific saved crawl"""
    from src.keyword_extractor import extract_keywords
    from src.crawl_db import get_crawl_by_id, load_crawled_urls, load_crawl_links
    from urllib.parse import urlparse

    try:
        user_id = session.get('user_id')
        crawl = get_crawl_by_id(crawl_id)
        if not crawl:
            return jsonify({'error': 'Crawl not found'}), 404
        if user_id and crawl.get('user_id') != user_id:
            return jsonify({'error': 'Unauthorized'}), 403

        limit = request.args.get('limit', 50, type=int)
        fmt = request.args.get('format', 'json')
        min_score = request.args.get('min_score', 0, type=float)

        urls = load_crawled_urls(crawl_id)
        links = load_crawl_links(crawl_id)
        domain = crawl.get('base_domain', '')
        keywords = extract_keywords(urls, links, limit=limit)

        if min_score > 0:
            keywords = [k for k in keywords if k['score'] >= min_score]

        for i, kw in enumerate(keywords):
            kw['rank'] = i + 1

        if fmt == 'csv':
            output = StringIO()
            writer = csv.writer(output)
            writer.writerow(['Keyword', 'Score', 'Frequency', 'Pages Found On', 'Source Fields', 'Search Volume', 'Competition'])
            for kw in keywords:
                writer.writerow([
                    kw['keyword'], kw['score'], kw['frequency'],
                    kw['pages'], '; '.join(kw['sources']), '', ''
                ])
            csv_content = output.getvalue()
            from flask import Response
            filename = f"keywords-{domain}-{datetime.now().strftime('%Y%m%d')}.csv"
            return Response(
                csv_content,
                mimetype='text/csv',
                headers={'Content-Disposition': f'attachment; filename="{filename}"'}
            )

        return jsonify({
            'domain': domain,
            'analyzed_at': datetime.now().isoformat(),
            'pages_analyzed': len(urls),
            'keywords': keywords
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai/config')
@login_required
def api_ai_config():
    """Return whether a server-side AI key is configured (without exposing it)."""
    key = os.getenv('AI_API_KEY', '')
    provider = os.getenv('AI_PROVIDER', '')
    model = os.getenv('AI_MODEL', '')
    return jsonify({
        'has_key': bool(key),
        'provider': provider if key else '',
        'model': model if key else '',
    })


@app.route('/api/keywords/ai')
@login_required
def api_keywords_ai():
    """AI-enhanced keyword analysis"""
    from src.keyword_extractor import extract_keywords, analyze_keywords_with_ai
    from src.crawl_db import save_ai_keywords
    from urllib.parse import urlparse

    try:
        provider = request.args.get('provider', os.getenv('AI_PROVIDER', 'openai'))
        api_key = request.args.get('api_key', os.getenv('AI_API_KEY', ''))
        model = request.args.get('model', os.getenv('AI_MODEL', ''))

        if not api_key:
            return jsonify({'error': 'API key required. Pass api_key param or set AI_API_KEY env var.'}), 400

        crawler = get_or_create_crawler()
        status_data = crawler.get_status()
        urls = status_data.get('urls', [])
        links = status_data.get('links', [])

        if not urls:
            return jsonify({'domain': '', 'analyzed_at': '', 'pages_analyzed': 0, 'keywords': []})

        domain = urlparse(crawler.base_url).netloc if crawler.base_url else ''

        # Get algorithmic keywords first
        algo_keywords = extract_keywords(urls, links, limit=50)

        # Enhance with AI
        used_model = model or None
        ai_result = analyze_keywords_with_ai(
            algo_keywords, urls, provider, api_key, model=used_model,
            domain=domain, links=links
        )

        if isinstance(ai_result, dict) and 'error' in ai_result:
            return jsonify(ai_result), 502

        # Add ranks to AI results
        for i, kw in enumerate(ai_result):
            kw['rank'] = i + 1

        # Persist to database if we have a crawl_id
        crawl_id = getattr(crawler, 'crawl_id', None)
        if crawl_id:
            save_ai_keywords(crawl_id, ai_result, provider, used_model or '', scope='site')

        return jsonify({
            'domain': domain,
            'analyzed_at': datetime.now().isoformat(),
            'pages_analyzed': len(urls),
            'provider': provider,
            'keywords': ai_result
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/keywords/ai/page', methods=['POST'])
@login_required
def api_keywords_ai_page():
    """AI keyword analysis for a single page"""
    from src.keyword_extractor import analyze_page_keywords_with_ai
    from src.crawl_db import save_ai_keywords
    from urllib.parse import urlparse

    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'JSON body required'}), 400

        target_url = data.get('url', '')
        provider = data.get('provider', os.getenv('AI_PROVIDER', 'openai'))
        api_key = data.get('api_key', os.getenv('AI_API_KEY', ''))
        model = data.get('model', os.getenv('AI_MODEL', ''))

        if not api_key:
            return jsonify({'error': 'API key required'}), 400
        if not target_url:
            return jsonify({'error': 'URL required'}), 400

        crawler = get_or_create_crawler()
        status_data = crawler.get_status()
        urls = status_data.get('urls', [])
        all_links = status_data.get('links', [])

        # Find the matching URL data
        url_data = None
        for u in urls:
            if u.get('url') == target_url:
                url_data = u
                break

        if not url_data:
            return jsonify({'error': 'URL not found in crawl data'}), 404

        domain = urlparse(crawler.base_url).netloc if crawler.base_url else ''

        # Collect links pointing to this page
        page_links = [l for l in all_links if l.get('target_url') == target_url]

        used_model = model or None
        ai_result = analyze_page_keywords_with_ai(
            url_data, provider, api_key, model=used_model,
            domain=domain, links=page_links
        )

        if isinstance(ai_result, dict) and 'error' in ai_result:
            return jsonify(ai_result), 502

        for i, kw in enumerate(ai_result):
            kw['rank'] = i + 1

        # Persist to database
        crawl_id = getattr(crawler, 'crawl_id', None)
        if crawl_id:
            save_ai_keywords(crawl_id, ai_result, provider, used_model or '', scope='page', page_url=target_url)

        return jsonify({
            'url': target_url,
            'domain': domain,
            'analyzed_at': datetime.now().isoformat(),
            'provider': provider,
            'keywords': ai_result
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/keywords/ai/stored')
@login_required
def api_keywords_ai_stored():
    """Return stored AI keyword results for the current crawl"""
    from src.crawl_db import load_ai_keywords

    try:
        crawler = get_or_create_crawler()
        crawl_id = getattr(crawler, 'crawl_id', None)
        if not crawl_id:
            return jsonify({'keywords': [], 'page_keywords': {}})

        all_kw = load_ai_keywords(crawl_id, scope=None)
        site_keywords = []
        page_keywords = {}

        for kw in all_kw:
            entry = {
                'keyword': kw['keyword'],
                'score': kw['score'],
                'category': kw['category'],
                'relevance': kw['relevance'],
                'rank': kw['rank'],
            }
            if kw['scope'] == 'site':
                site_keywords.append(entry)
            elif kw['scope'] == 'page' and kw.get('page_url'):
                page_keywords.setdefault(kw['page_url'], []).append(entry)

        return jsonify({
            'keywords': site_keywords,
            'page_keywords': page_keywords,
            'provider': all_kw[0]['provider'] if all_kw else '',
            'analyzed_at': all_kw[0]['analyzed_at'] if all_kw else '',
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# --- Google Business Profile (GBP) Endpoints ---

def _get_user_google_places_key():
    """Get Google Places API key from user's saved settings."""
    user_id = session.get('user_id')
    if not user_id:
        return ''
    from src.auth_db import get_user_settings
    settings = get_user_settings(user_id)
    if settings:
        return settings.get('google_places_api_key', '')
    return ''


@app.route('/api/gbp', methods=['GET', 'POST'])
@login_required
def api_gbp():
    """GBP data for active crawl session (GET) or from provided data (POST)."""
    from src.gbp_extractor import build_gbp_report, extract_business_info
    from src.crawl_db import load_gbp_data, save_gbp_data

    try:
        # Resolve API key: request param → user settings → env var
        if request.method == 'POST':
            body = request.get_json() or {}
            api_key = body.get('api_key', '')
        else:
            body = {}
            api_key = request.args.get('api_key', '')

        if not api_key:
            api_key = _get_user_google_places_key()
        if not api_key:
            api_key = os.getenv('GOOGLE_PLACES_API_KEY', '')

        # Get crawl data
        if request.method == 'POST' and body.get('urls'):
            urls = body['urls']
            crawl_id = None
        else:
            crawler = get_or_create_crawler()
            status_data = crawler.get_status()
            urls = status_data.get('urls', [])
            crawl_id = getattr(crawler, 'crawl_id', None)

        if not urls:
            return jsonify({'error': 'No crawl data available'}), 404

        # Check cache
        if crawl_id:
            cached = load_gbp_data(crawl_id)
            if cached:
                return jsonify(cached)

        # Without API key, return only extracted contact info
        if not api_key:
            extracted = extract_business_info(urls)
            result = {
                'domain': '',
                'brand_name': extracted.get('brand_name', ''),
                'branches': [{
                    'extracted': branch,
                    'gbp': None,
                    'match_confidence': 0,
                    'search_query': '',
                    'all_candidates': [],
                } for branch in extracted.get('branches', [])],
                'analyzed_at': __import__('datetime').datetime.now().isoformat(),
                'no_api_key': True,
            }
            return jsonify(result)

        # Full GBP lookup
        report = build_gbp_report(urls, api_key)

        # Cache if we have a crawl_id and no errors
        if crawl_id and not any(b.get('error') for b in report.get('branches', [])):
            save_gbp_data(crawl_id, report)

        return jsonify(report)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/gbp/<int:crawl_id>')
@login_required
def api_gbp_by_crawl(crawl_id):
    """GBP data for a specific saved crawl."""
    from src.gbp_extractor import build_gbp_report, extract_business_info
    from src.crawl_db import load_gbp_data, save_gbp_data, load_crawled_urls

    try:
        # Check cache first
        cached = load_gbp_data(crawl_id)
        if cached:
            return jsonify(cached)

        # Resolve API key
        api_key = (
            request.args.get('api_key') or
            _get_user_google_places_key() or
            os.getenv('GOOGLE_PLACES_API_KEY', '')
        )

        urls = load_crawled_urls(crawl_id)
        if not urls:
            return jsonify({'error': 'No crawl data found'}), 404

        # Without API key, return only extracted contact info
        if not api_key:
            extracted = extract_business_info(urls)
            from urllib.parse import urlparse as _urlparse
            domain = _urlparse(urls[0].get('url', '')).netloc if urls else ''
            result = {
                'domain': domain,
                'brand_name': extracted.get('brand_name', ''),
                'branches': [{
                    'extracted': branch,
                    'gbp': None,
                    'match_confidence': 0,
                    'search_query': '',
                    'all_candidates': [],
                } for branch in extracted.get('branches', [])],
                'analyzed_at': __import__('datetime').datetime.now().isoformat(),
                'no_api_key': True,
            }
            return jsonify(result)

        report = build_gbp_report(urls, api_key)
        if not any(b.get('error') for b in report.get('branches', [])):
            save_gbp_data(crawl_id, report)

        return jsonify(report)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/gbp/photo')
@login_required
def api_gbp_photo():
    """Proxy for Google Places photo URLs (avoids exposing API key to browser)."""
    from src.gbp_extractor import get_photo_uri

    photo_name = request.args.get('name', '')
    if not photo_name:
        return jsonify({'error': 'Photo name required'}), 400

    api_key = (
        request.args.get('api_key') or
        _get_user_google_places_key() or
        os.getenv('GOOGLE_PLACES_API_KEY', '')
    )
    if not api_key:
        return jsonify({'error': 'No API key'}), 400

    max_width = request.args.get('max_width', 400, type=int)
    photo_url = get_photo_uri(photo_name, api_key, max_width)
    return jsonify({'url': photo_url})


@app.route('/api/export_data', methods=['POST'])
@login_required
def export_data():
    try:
        data = request.get_json()
        export_format = data.get('format', 'csv')
        export_fields = data.get('fields', ['url', 'status_code', 'title'])
        local_data = data.get('localData', {})

        # Use local data if provided (from loaded crawl), otherwise get from crawler
        if local_data and local_data.get('urls'):
            urls = local_data.get('urls', [])
            links = local_data.get('links', [])
            issues = local_data.get('issues', [])
        else:
            # Get current crawl results
            crawler = get_or_create_crawler()
            crawl_data = crawler.get_status()
            urls = crawl_data.get('urls', [])
            links = crawl_data.get('links', [])
            issues = crawl_data.get('issues', [])

        if not urls:
            return jsonify({'success': False, 'error': 'No data to export'})

        # Update link statuses from crawled URLs (fixes missing status codes in exports)
        if links and urls:
            status_lookup = {url_data['url']: url_data.get('status_code') for url_data in urls}
            for link in links:
                target_url = link.get('target_url')
                if target_url in status_lookup:
                    link['target_status'] = status_lookup[target_url]

        # Apply current issue exclusion patterns (works for loaded crawls too)
        if issues:
            settings_manager = get_session_settings()
            current_settings = settings_manager.get_settings()
            exclusion_patterns_text = current_settings.get('issueExclusionPatterns', '')
            exclusion_patterns = [p.strip() for p in exclusion_patterns_text.split('\n') if p.strip()]
            issues = filter_issues_by_exclusion_patterns(issues, exclusion_patterns)
            print(f"DEBUG: After exclusion filter, {len(issues)} issues remain")

        # Collect files to export based on special field selections
        files_to_export = []

        # Check for special export fields and prepare them as separate files
        has_issues_export = 'issues_detected' in export_fields
        has_links_export = 'links_detailed' in export_fields

        # Remove special fields from regular export fields
        regular_fields = [f for f in export_fields if f not in ['issues_detected', 'links_detailed']]

        # Debug logging
        print(f"DEBUG: export_fields = {export_fields}")
        print(f"DEBUG: has_issues_export = {has_issues_export}")
        print(f"DEBUG: has_links_export = {has_links_export}")
        print(f"DEBUG: regular_fields = {regular_fields}")
        print(f"DEBUG: len(urls) = {len(urls)}")
        print(f"DEBUG: len(links) = {len(links)}")
        print(f"DEBUG: len(issues) = {len(issues)}")

        # Generate issues export if requested
        if has_issues_export:
            if export_format == 'csv':
                issues_content = generate_issues_csv_export(issues)
                issues_mimetype = 'text/csv'
                issues_filename = f'librecrawl_issues_{int(time.time())}.csv'
            elif export_format == 'json':
                issues_content = generate_issues_json_export(issues)
                issues_mimetype = 'application/json'
                issues_filename = f'librecrawl_issues_{int(time.time())}.json'
            else:
                issues_content = generate_issues_csv_export(issues)
                issues_mimetype = 'text/csv'
                issues_filename = f'librecrawl_issues_{int(time.time())}.csv'

            files_to_export.append({
                'content': issues_content,
                'mimetype': issues_mimetype,
                'filename': issues_filename
            })

        # Generate links export if requested
        if has_links_export:
            if export_format == 'csv':
                links_content = generate_links_csv_export(links)
                links_mimetype = 'text/csv'
                links_filename = f'librecrawl_links_{int(time.time())}.csv'
            elif export_format == 'json':
                links_content = generate_links_json_export(links)
                links_mimetype = 'application/json'
                links_filename = f'librecrawl_links_{int(time.time())}.json'
            else:
                links_content = generate_links_csv_export(links)
                links_mimetype = 'text/csv'
                links_filename = f'librecrawl_links_{int(time.time())}.csv'

            files_to_export.append({
                'content': links_content,
                'mimetype': links_mimetype,
                'filename': links_filename
            })

        # Generate regular export if there are regular fields
        if regular_fields:
            if export_format == 'csv':
                regular_content = generate_csv_export(urls, regular_fields)
                regular_mimetype = 'text/csv'
                regular_filename = f'librecrawl_export_{int(time.time())}.csv'
            elif export_format == 'json':
                regular_content = generate_json_export(urls, regular_fields)
                regular_mimetype = 'application/json'
                regular_filename = f'librecrawl_export_{int(time.time())}.json'
            elif export_format == 'xml':
                regular_content = generate_xml_export(urls, regular_fields)
                regular_mimetype = 'application/xml'
                regular_filename = f'librecrawl_export_{int(time.time())}.xml'
            else:
                return jsonify({'success': False, 'error': 'Unsupported export format'})

            files_to_export.append({
                'content': regular_content,
                'mimetype': regular_mimetype,
                'filename': regular_filename
            })

        # Handle special case where only special fields are selected but no data
        if not files_to_export:
            if has_issues_export and not issues:
                return jsonify({'success': False, 'error': 'No issues data to export'})
            elif has_links_export and not links:
                return jsonify({'success': False, 'error': 'No links data to export'})
            else:
                return jsonify({'success': False, 'error': 'No data to export'})

        # Return multiple files if we have more than one, otherwise single file
        if len(files_to_export) > 1:
            return jsonify({
                'success': True,
                'multiple_files': True,
                'files': files_to_export
            })
        else:
            # Single file
            file_data = files_to_export[0]
            return jsonify({
                'success': True,
                'content': file_data['content'],
                'mimetype': file_data['mimetype'],
                'filename': file_data['filename']
            })

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

def recover_crashed_crawls():
    """Check for and recover any crashed crawls on startup"""
    try:
        from src.crawl_db import get_crashed_crawls, set_crawl_status

        crashed = get_crashed_crawls()

        if crashed:
            print("\n" + "=" * 60)
            print("CRASH RECOVERY")
            print("=" * 60)
            for crawl in crashed:
                set_crawl_status(crawl['id'], 'failed')
                print(f"Found crashed crawl: {crawl['base_url']} (ID: {crawl['id']})")
                print(f"  → Marked as failed. User can resume from dashboard.")
            print("=" * 60 + "\n")
    except Exception as e:
        print(f"Error during crash recovery: {e}")

# ============================================================
# Research API — programmatic crawl + keyword extraction
# ============================================================

# Registry for research crawl jobs (independent of session-based crawlers)
research_jobs = {}  # job_id -> {'crawler': WebCrawler, 'created_at': datetime, 'keyword_limit': int}
research_jobs_lock = threading.Lock()

def _cleanup_research_jobs():
    """Remove research jobs older than 30 minutes."""
    cutoff = datetime.now() - timedelta(minutes=30)
    with research_jobs_lock:
        to_remove = [jid for jid, job in research_jobs.items() if job['created_at'] < cutoff]
        for jid in to_remove:
            try:
                research_jobs[jid]['crawler'].stop_crawl()
            except:
                pass
            del research_jobs[jid]
        if to_remove:
            print(f"Cleaned up {len(to_remove)} stale research jobs")

def _get_local_user_id():
    """Get the local admin user ID for API requests (creates user if needed)."""
    import sqlite3
    try:
        db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'users.db')
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE username = ?', ('local',))
        user = cursor.fetchone()
        conn.close()
        return user['id'] if user else None
    except Exception:
        return None


def _get_api_user_id():
    """Resolve user_id for API requests from any auth method."""
    # From Bearer token auth
    if hasattr(request, '_api_user_id'):
        return request._api_user_id
    # From session
    if session.get('user_id'):
        return session['user_id']
    # In local mode, get the local user
    if LOCAL_MODE:
        return _get_local_user_id()
    return None


def api_auth_required(f):
    """Auth decorator for programmatic API access.
    In LOCAL_MODE: accepts X-Local-Auth header (no session needed).
    Otherwise: requires Authorization: Bearer <api_key> header.
    Falls back to session auth."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Check X-Local-Auth header in local mode
        if LOCAL_MODE and request.headers.get('X-Local-Auth', '').lower() == 'true':
            return f(*args, **kwargs)

        # Check Bearer token
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            api_key = auth_header[7:]
            user_id, tier = validate_api_key(api_key)
            if user_id:
                request._api_user_id = user_id
                request._api_tier = tier
                return f(*args, **kwargs)
            return jsonify({'error': 'Invalid API key'}), 401

        # Fall back to session auth
        if LOCAL_MODE and 'user_id' not in session:
            auto_login_local_mode()
        if 'user_id' in session:
            return f(*args, **kwargs)

        return jsonify({'error': 'Authentication required. Use X-Local-Auth: true (local mode) or Authorization: Bearer <key>'}), 401
    return decorated_function


def _build_research_response(crawler, keyword_limit=50, google_places_api_key=''):
    """Build AI-optimized response from crawler results."""
    from src.keyword_extractor import extract_keywords

    status_data = crawler.get_status()
    urls = status_data.get('urls', [])
    links = status_data.get('links', [])
    issues = status_data.get('issues', [])
    stats = status_data.get('stats', {})

    # Extract keywords
    keywords = extract_keywords(urls, links, limit=keyword_limit)

    # Find homepage data
    homepage = None
    base_url = crawler.base_url or ''
    for u in urls:
        url_str = u.get('url', '')
        if url_str.rstrip('/') == base_url.rstrip('/'):
            homepage = u
            break
    if not homepage and urls:
        homepage = urls[0]

    # Compute site summary
    word_counts = [u.get('word_count', 0) for u in urls if u.get('word_count')]
    avg_word_count = round(sum(word_counts) / max(len(word_counts), 1))

    issues_by_category = {}
    for issue in issues:
        cat = issue.get('category', 'Other')
        issues_by_category[cat] = issues_by_category.get(cat, 0) + 1

    schema_types = set()
    for u in urls:
        for st in (u.get('schema_org') or []):
            if isinstance(st, str):
                schema_types.add(st)
            elif isinstance(st, dict):
                st_type = st.get('@type') or st.get('type') or ''
                if st_type:
                    # Extract just the type name from full URI like https://schema.org/Blog
                    schema_types.add(st_type.rsplit('/', 1)[-1] if '/' in st_type else st_type)

    # Build pages array (flattened SEO fields)
    pages = []
    for u in urls:
        images = u.get('images') or []
        images_missing_alt = sum(1 for img in images if not img.get('alt'))
        pages.append({
            'url': u.get('url'),
            'status_code': u.get('status_code'),
            'title': u.get('title'),
            'meta_description': u.get('meta_description'),
            'h1': u.get('h1'),
            'h2': u.get('h2', []),
            'h3': u.get('h3', []),
            'word_count': u.get('word_count', 0),
            'canonical': u.get('canonical_url'),
            'has_og_tags': bool(u.get('og_tags')),
            'has_json_ld': bool(u.get('json_ld')),
            'schema_types': [
                (s.rsplit('/', 1)[-1] if '/' in s else s) if isinstance(s, str)
                else ((s.get('@type') or s.get('type') or '').rsplit('/', 1)[-1] if isinstance(s, dict) else str(s))
                for s in (u.get('schema_org') or [])
                if (isinstance(s, str)) or (isinstance(s, dict) and (s.get('@type') or s.get('type')))
            ],
            'images_count': len(images),
            'images_missing_alt': images_missing_alt,
            'internal_links': u.get('internal_links', 0),
            'external_links': u.get('external_links', 0),
        })

    # Build link profile
    total_internal = sum(1 for l in links if l.get('is_internal'))
    total_external = sum(1 for l in links if not l.get('is_internal'))
    external_domains = set()
    for l in links:
        if not l.get('is_internal'):
            domain = l.get('target_domain', '')
            if domain:
                external_domains.add(domain)

    broken_links = []
    broken_urls_seen = set()
    for u in urls:
        sc = u.get('status_code', 0)
        if sc and sc >= 400:
            url_str = u.get('url', '')
            if url_str not in broken_urls_seen:
                broken_urls_seen.add(url_str)
                broken_links.append({
                    'url': url_str,
                    'status_code': sc,
                    'linked_from': u.get('linked_from', [])[:5]
                })

    # Top anchor texts
    anchor_counts = {}
    for l in links:
        text = (l.get('anchor_text') or '').strip()
        if text and len(text) > 1:
            anchor_counts[text] = anchor_counts.get(text, 0) + 1
    top_anchors = sorted(anchor_counts.items(), key=lambda x: x[1], reverse=True)[:15]

    elapsed = 0
    if stats.get('start_time'):
        elapsed = round(time.time() - stats['start_time'], 1)

    response = {
        'status': 'completed',
        'meta': {
            'url': base_url,
            'domain': crawler.base_domain or '',
            'pages_crawled': stats.get('crawled', len(urls)),
            'pages_discovered': stats.get('discovered', 0),
            'crawl_duration_seconds': elapsed,
            'analyzed_at': datetime.now().isoformat(),
        },
        'site_summary': {
            'homepage_title': (homepage or {}).get('title', ''),
            'homepage_meta_description': (homepage or {}).get('meta_description', ''),
            'homepage_h1': (homepage or {}).get('h1', ''),
            'avg_word_count': avg_word_count,
            'total_issues': len(issues),
            'issues_by_category': issues_by_category,
            'has_structured_data': bool(schema_types),
            'has_og_tags': any(u.get('og_tags') for u in urls),
            'schema_types_found': sorted(schema_types),
        },
        'keywords': keywords,
        'pages': pages,
        'issues': issues[:100],  # Cap at 100 for response size
        'link_profile': {
            'total_internal_links': total_internal,
            'total_external_links': total_external,
            'unique_external_domains': sorted(external_domains)[:50],
            'broken_links': broken_links[:20],
            'top_anchor_texts': [{'text': t, 'count': c} for t, c in top_anchors],
        }
    }

    # Inject GBP data if API key provided
    if google_places_api_key:
        try:
            from src.gbp_extractor import build_gbp_report
            response['gbp'] = build_gbp_report(urls, google_places_api_key)
        except Exception as e:
            response['gbp'] = {'error': str(e)}

    return response


def _build_response_from_saved_crawl(crawl, keyword_limit=50, google_places_api_key=''):
    """Build AI-optimized response from a previously saved crawl in the database."""
    from src.keyword_extractor import extract_keywords
    from src.crawl_db import load_crawled_urls, load_crawl_links, load_crawl_issues

    crawl_id = crawl['id']
    urls = load_crawled_urls(crawl_id)
    links = load_crawl_links(crawl_id)
    issues = load_crawl_issues(crawl_id)

    # Extract keywords from saved data
    keywords = extract_keywords(urls, links, limit=keyword_limit)

    # Find homepage
    base_url = crawl.get('base_url', '')
    homepage = None
    for u in urls:
        if u.get('url', '').rstrip('/') == base_url.rstrip('/'):
            homepage = u
            break
    if not homepage and urls:
        homepage = urls[0]

    # Compute summary
    word_counts = [u.get('word_count', 0) for u in urls if u.get('word_count')]
    avg_word_count = round(sum(word_counts) / max(len(word_counts), 1))

    issues_by_category = {}
    for issue in issues:
        cat = issue.get('category', 'Other')
        issues_by_category[cat] = issues_by_category.get(cat, 0) + 1

    schema_types = set()
    for u in urls:
        for st in (u.get('schema_org') or []):
            if isinstance(st, str):
                schema_types.add(st)
            elif isinstance(st, dict):
                st_type = st.get('@type') or st.get('type') or ''
                if st_type:
                    # Extract just the type name from full URI like https://schema.org/Blog
                    schema_types.add(st_type.rsplit('/', 1)[-1] if '/' in st_type else st_type)

    pages = []
    for u in urls:
        images = u.get('images') or []
        images_missing_alt = sum(1 for img in images if not img.get('alt'))
        pages.append({
            'url': u.get('url'),
            'status_code': u.get('status_code'),
            'title': u.get('title'),
            'meta_description': u.get('meta_description'),
            'h1': u.get('h1'),
            'h2': u.get('h2', []),
            'h3': u.get('h3', []),
            'word_count': u.get('word_count', 0),
            'canonical': u.get('canonical_url'),
            'has_og_tags': bool(u.get('og_tags')),
            'has_json_ld': bool(u.get('json_ld')),
            'schema_types': [
                (s.rsplit('/', 1)[-1] if '/' in s else s) if isinstance(s, str)
                else ((s.get('@type') or s.get('type') or '').rsplit('/', 1)[-1] if isinstance(s, dict) else str(s))
                for s in (u.get('schema_org') or [])
                if (isinstance(s, str)) or (isinstance(s, dict) and (s.get('@type') or s.get('type')))
            ],
            'images_count': len(images),
            'images_missing_alt': images_missing_alt,
            'internal_links': u.get('internal_links', 0),
            'external_links': u.get('external_links', 0),
        })

    total_internal = sum(1 for l in links if l.get('is_internal'))
    total_external = sum(1 for l in links if not l.get('is_internal'))
    external_domains = set()
    for l in links:
        if not l.get('is_internal'):
            domain = l.get('target_domain', '')
            if domain:
                external_domains.add(domain)

    broken_links = []
    for u in urls:
        sc = u.get('status_code', 0)
        if sc and sc >= 400:
            broken_links.append({
                'url': u.get('url', ''),
                'status_code': sc,
                'linked_from': u.get('linked_from', [])[:5]
            })

    anchor_counts = {}
    for l in links:
        text = (l.get('anchor_text') or '').strip()
        if text and len(text) > 1:
            anchor_counts[text] = anchor_counts.get(text, 0) + 1
    top_anchors = sorted(anchor_counts.items(), key=lambda x: x[1], reverse=True)[:15]

    response = {
        'status': 'completed',
        'cached': True,
        'meta': {
            'url': base_url,
            'domain': crawl.get('base_domain', ''),
            'pages_crawled': crawl.get('urls_crawled', len(urls)),
            'pages_discovered': crawl.get('urls_discovered', 0),
            'crawl_id': crawl_id,
            'crawled_at': crawl.get('completed_at', ''),
            'analyzed_at': datetime.now().isoformat(),
        },
        'site_summary': {
            'homepage_title': (homepage or {}).get('title', ''),
            'homepage_meta_description': (homepage or {}).get('meta_description', ''),
            'homepage_h1': (homepage or {}).get('h1', ''),
            'avg_word_count': avg_word_count,
            'total_issues': len(issues),
            'issues_by_category': issues_by_category,
            'has_structured_data': bool(schema_types),
            'has_og_tags': any(u.get('og_tags') for u in urls),
            'schema_types_found': sorted(schema_types),
        },
        'keywords': keywords,
        'pages': pages,
        'issues': issues[:100],
        'link_profile': {
            'total_internal_links': total_internal,
            'total_external_links': total_external,
            'unique_external_domains': sorted(external_domains)[:50],
            'broken_links': broken_links[:20],
            'top_anchor_texts': [{'text': t, 'count': c} for t, c in top_anchors],
        }
    }

    # Inject GBP data if API key provided
    if google_places_api_key:
        try:
            from src.gbp_extractor import build_gbp_report
            response['gbp'] = build_gbp_report(urls, google_places_api_key)
        except Exception as e:
            response['gbp'] = {'error': str(e)}

    return response


@app.route('/api/research', methods=['POST'])
@api_auth_required
def api_research():
    """Programmatic endpoint: crawl a URL and return structured SEO + keyword data.
    If a recent crawl exists for the same domain, returns cached results."""
    data = request.get_json()
    if not data or not data.get('url'):
        return jsonify({'error': 'url is required'}), 400

    url = data['url']
    max_urls = data.get('max_urls', 500)
    max_depth = data.get('max_depth', 3)
    keyword_limit = data.get('keyword_limit', 50)
    timeout = min(data.get('timeout', 180), 600)  # Cap at 10 minutes
    force_recrawl = data.get('force_recrawl', False)
    cache_max_age_hours = data.get('cache_max_age_hours', 24)
    google_places_api_key = data.get('google_places_api_key') or os.getenv('GOOGLE_PLACES_API_KEY', '')

    # Normalize URL
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url

    # Check for existing recent crawl (unless force_recrawl)
    if not force_recrawl:
        from urllib.parse import urlparse as _urlparse
        from src.crawl_db import find_recent_crawl_by_domain
        parsed = _urlparse(url)
        domain = parsed.netloc
        existing, total_count = find_recent_crawl_by_domain(domain, max_age_hours=cache_max_age_hours)
        if existing:
            print(f"Research API: returning cached crawl {existing['id']} for {domain} ({total_count} total crawls)")
            result = _build_response_from_saved_crawl(existing, keyword_limit, google_places_api_key=google_places_api_key)
            result['meta']['total_crawls_for_domain'] = total_count
            if total_count > 1:
                result['meta']['note'] = f'{total_count} crawls exist for this domain. Returning the most recent one. Use force_recrawl=true to trigger a fresh crawl.'
            return jsonify(result)

    # Create a standalone crawler with research-optimized config
    crawler = WebCrawler()
    crawler.update_config({
        'max_depth': max_depth,
        'max_urls': max_urls,
        'delay': 0.5,
        'concurrency': 3,
        'timeout': 8,
        'discover_sitemaps': True,
        'enable_pagespeed': False,
        'enable_javascript': False,
        'respect_robots': True,
    })

    # Start crawl with user binding for crawl history visibility
    synthetic_session = f"research_{uuid.uuid4().hex[:12]}"
    user_id = _get_api_user_id()
    success, message = crawler.start_crawl(url, user_id=user_id, session_id=synthetic_session)
    if not success:
        return jsonify({'error': message}), 400

    job_id = f"r_{uuid.uuid4().hex[:12]}"

    # Poll until completion or timeout
    start = time.time()
    while crawler.is_running and (time.time() - start) < timeout:
        time.sleep(1)

    if crawler.is_running:
        # Crawl still running — store for later retrieval
        with research_jobs_lock:
            research_jobs[job_id] = {
                'crawler': crawler,
                'created_at': datetime.now(),
                'keyword_limit': keyword_limit,
                'google_places_api_key': google_places_api_key,
            }
        status_data = crawler.get_status()
        return jsonify({
            'status': 'running',
            'job_id': job_id,
            'progress': round(status_data.get('progress', 0)),
            'pages_crawled': status_data.get('stats', {}).get('crawled', 0),
            'message': f'Crawl still in progress. Poll GET /api/research/{job_id} for results.',
        }), 202

    # Crawl completed — return results immediately
    return jsonify(_build_research_response(crawler, keyword_limit, google_places_api_key=google_places_api_key))


@app.route('/api/research/<job_id>')
@api_auth_required
def api_research_poll(job_id):
    """Poll for results of a research crawl that exceeded the initial timeout."""
    with research_jobs_lock:
        job = research_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404

    crawler = job['crawler']
    if crawler.is_running:
        status_data = crawler.get_status()
        return jsonify({
            'status': 'running',
            'job_id': job_id,
            'progress': round(status_data.get('progress', 0)),
            'pages_crawled': status_data.get('stats', {}).get('crawled', 0),
            'message': 'Crawl still in progress.',
        }), 202

    # Completed — build response and clean up
    result = _build_research_response(crawler, job.get('keyword_limit', 50), google_places_api_key=job.get('google_places_api_key', ''))
    with research_jobs_lock:
        research_jobs.pop(job_id, None)
    return jsonify(result)


def _build_images_response(urls, domain=''):
    """Build image-focused response from crawl URL data."""
    pages = []
    total_images = 0
    total_missing_alt = 0
    total_long_alt = 0
    all_images_flat = []

    for u in urls:
        images = u.get('images') or []
        if not images:
            continue

        page_images = []
        for img in images:
            src = img.get('src', '')
            alt = img.get('alt', '')
            img_entry = {
                'src': src,
                'alt': alt,
                'width': img.get('width', ''),
                'height': img.get('height', ''),
                'missing_alt': not alt,
                'long_alt': len(alt) > 80 if alt else False,
                'context': img.get('context'),
            }
            page_images.append(img_entry)
            all_images_flat.append({**img_entry, 'page_url': u.get('url', '')})
            total_images += 1
            if not alt:
                total_missing_alt += 1
            elif len(alt) > 80:
                total_long_alt += 1

        pages.append({
            'url': u.get('url', ''),
            'title': u.get('title', ''),
            'images_count': len(page_images),
            'images_missing_alt': sum(1 for i in page_images if i['missing_alt']),
            'images': page_images,
        })

    # Find duplicate images (same src across multiple pages)
    src_pages = {}
    for img in all_images_flat:
        src = img['src']
        if src:
            if src not in src_pages:
                src_pages[src] = set()
            src_pages[src].add(img['page_url'])
    duplicate_images = [
        {'src': src, 'found_on_pages': len(page_set), 'pages': sorted(page_set)[:5]}
        for src, page_set in src_pages.items() if len(page_set) > 1
    ]
    duplicate_images.sort(key=lambda x: x['found_on_pages'], reverse=True)

    return {
        'status': 'completed',
        'meta': {
            'domain': domain,
            'pages_with_images': len(pages),
            'analyzed_at': datetime.now().isoformat(),
        },
        'summary': {
            'total_images': total_images,
            'missing_alt': total_missing_alt,
            'long_alt': total_long_alt,
            'has_alt': total_images - total_missing_alt,
            'duplicate_images': len(duplicate_images),
            'alt_coverage_percent': round((total_images - total_missing_alt) / max(total_images, 1) * 100, 1),
        },
        'pages': pages,
        'duplicate_images': duplicate_images[:50],
    }


@app.route('/api/research/images', methods=['POST'])
@api_auth_required
def api_research_images():
    """Return per-page image data (src, alt, width, height) for a domain.
    Uses cached crawl data if available, otherwise triggers a new crawl."""
    data = request.get_json()
    if not data or not data.get('url'):
        return jsonify({'error': 'url is required'}), 400

    url = data['url']
    force_recrawl = data.get('force_recrawl', False)
    cache_max_age_hours = data.get('cache_max_age_hours', 24)
    timeout = min(data.get('timeout', 180), 600)

    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url

    from urllib.parse import urlparse as _urlparse
    parsed = _urlparse(url)
    domain = parsed.netloc.replace('www.', '', 1) if parsed.netloc.startswith('www.') else parsed.netloc

    # Check for cached crawl
    if not force_recrawl:
        from src.crawl_db import find_recent_crawl_by_domain, load_crawled_urls
        existing, total_count = find_recent_crawl_by_domain(domain, max_age_hours=cache_max_age_hours)
        if existing:
            urls_data = load_crawled_urls(existing['id'])
            result = _build_images_response(urls_data, domain)
            result['cached'] = True
            result['meta']['crawl_id'] = existing['id']
            result['meta']['crawled_at'] = existing.get('completed_at', '')
            return jsonify(result)

    # No cache — trigger a crawl
    max_urls = data.get('max_urls', 500)
    max_depth = data.get('max_depth', 3)

    crawler = WebCrawler()
    crawler.update_config({
        'max_depth': max_depth,
        'max_urls': max_urls,
        'delay': 0.5,
        'concurrency': 3,
        'timeout': 8,
        'discover_sitemaps': True,
        'enable_pagespeed': False,
        'enable_javascript': False,
        'respect_robots': True,
    })

    synthetic_session = f"research_{uuid.uuid4().hex[:12]}"
    user_id = _get_api_user_id()
    success, message = crawler.start_crawl(url, user_id=user_id, session_id=synthetic_session)
    if not success:
        return jsonify({'error': message}), 400

    # Poll until completion or timeout
    start = time.time()
    while crawler.is_running and (time.time() - start) < timeout:
        time.sleep(1)

    if crawler.is_running:
        crawler.stop_crawl()
        return jsonify({'error': 'Crawl timed out. Try again or increase timeout.'}), 504

    status_data = crawler.get_status()
    result = _build_images_response(status_data.get('urls', []), domain)
    result['cached'] = False
    result['meta']['crawl_duration_seconds'] = round(time.time() - start, 1)
    return jsonify(result)


# --- API Key Management Endpoints ---

@app.route('/api/keys', methods=['GET', 'POST'])
@login_required
def api_keys_endpoint():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Authentication required'}), 401

    if request.method == 'POST':
        data = request.get_json() or {}
        name = data.get('name', 'default')
        key_id, key = create_api_key(user_id, name)
        if key:
            return jsonify({'id': key_id, 'key': key, 'name': name})
        return jsonify({'error': 'Failed to create API key'}), 500

    # GET — list keys
    keys = list_api_keys(user_id)
    return jsonify({'keys': keys})


@app.route('/api/keys/<int:key_id>', methods=['DELETE'])
@login_required
def api_keys_delete(key_id):
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Authentication required'}), 401
    if revoke_api_key(key_id, user_id):
        return jsonify({'success': True})
    return jsonify({'error': 'Key not found or already revoked'}), 404


# ============================================================


def graceful_shutdown(signum, frame):
    """Save all active crawls before shutdown"""
    print("\n" + "=" * 60)
    print("GRACEFUL SHUTDOWN")
    print("=" * 60)
    print("Saving all active crawls...")

    try:
        with instances_lock:
            for session_id, instance_data in list(crawler_instances.items()):
                crawler = instance_data['crawler']
                if crawler.is_running and crawler.crawl_id and crawler.db_save_enabled:
                    print(f"  → Saving crawl {crawler.crawl_id}...")
                    try:
                        crawler._save_batch_to_db(force=True)
                        crawler._save_queue_checkpoint()
                        from src.crawl_db import set_crawl_status
                        set_crawl_status(crawler.crawl_id, 'paused')
                    except Exception as e:
                        print(f"    Error saving crawl {crawler.crawl_id}: {e}")

        print("All crawls saved successfully")
        print("=" * 60)
    except Exception as e:
        print(f"Error during shutdown: {e}")

    print("Goodbye!")
    import sys
    sys.exit(0)

def main():
    import signal

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, graceful_shutdown)
    signal.signal(signal.SIGTERM, graceful_shutdown)

    # Recover any crashed crawls from previous session
    recover_crashed_crawls()

    # Start cleanup thread for old crawler instances
    start_cleanup_thread()

    print("=" * 60)
    print("LibreCrawl - SEO Spider")
    print("=" * 60)
    print(f"\n🚀 Server starting on http://0.0.0.0:5000")
    print(f"🌐 Access from browser: http://localhost:5000")
    print(f"📱 Access from network: http://<your-ip>:5000")
    print(f"\n✨ Multi-tenancy enabled - each browser session is isolated")
    print(f"💾 Settings stored in browser localStorage")
    print(f"\nPress Ctrl+C to stop the server\n")
    print("=" * 60 + "\n")

    # Open browser in a separate thread after short delay
    def open_browser():
        time.sleep(1.5)  # Wait for Flask to start
        webbrowser.open('http://localhost:5000')

    browser_thread = threading.Thread(target=open_browser, daemon=True)
    browser_thread.start()

    # Run Flask server with Waitress (production-grade WSGI server)
    from waitress import serve
    print("Starting LibreCrawl on http://localhost:5000")
    print("Using Waitress WSGI server with multi-threading support")
    serve(app, host='0.0.0.0', port=int(os.getenv('PORT', '5000')), threads=8)

if __name__ == '__main__':
    main()