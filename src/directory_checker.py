"""
Directory verification and registration engine.

DirectoryVerifier — automated batch checking (read-only, safe)
DirectoryRegistrationSession — interactive form-filling with screenshot relay
"""

import asyncio
import threading
import time
import logging
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)

# In-memory registration sessions keyed by session_id
_registration_sessions = {}


def _fuzzy_match(needle, haystack, threshold=70):
    """Fuzzy string match. Returns score 0-100."""
    try:
        from rapidfuzz import fuzz
        return fuzz.token_sort_ratio(needle.lower(), haystack.lower())
    except ImportError:
        # Fallback: simple containment check
        n = needle.lower().strip()
        h = haystack.lower().strip()
        if n == h:
            return 100
        if n in h or h in n:
            return 80
        return 0


def _normalise_phone(phone):
    """Strip all non-digit characters for phone comparison."""
    return ''.join(c for c in phone if c.isdigit())


class DirectoryVerifier:
    """
    Batch-verify business presence across multiple directories.
    Uses Playwright page pool for concurrent checking.
    """

    def __init__(self, max_concurrent=3, timeout_per_directory=30):
        self.max_concurrent = max_concurrent
        self.timeout = timeout_per_directory * 1000  # Playwright uses ms

    async def verify(self, business_name, location, phone=None, address=None,
                     website=None, directories=None):
        """
        Check if a business is listed on specified directories.

        If directories is None, checks all directories in the registry.
        Returns list of results.
        """
        from src.directory_registry import get_registry

        registry = get_registry()

        if directories:
            to_check = {k: v for k, v in registry.items() if k in directories}
        else:
            to_check = registry

        if not to_check:
            return {'status': 'error', 'message': 'No directories to check'}

        results = []
        semaphore = asyncio.Semaphore(self.max_concurrent)

        async def check_one(key, entry):
            async with semaphore:
                return await self._check_directory(
                    key, entry, business_name, location, phone, address, website
                )

        tasks = [check_one(k, v) for k, v in to_check.items()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Convert exceptions to error results
        final_results = []
        keys = list(to_check.keys())
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                final_results.append({
                    'directory': keys[i],
                    'directory_name': to_check[keys[i]].get('name', keys[i]),
                    'listed': None,
                    'confidence': 0,
                    'error': str(result),
                })
            else:
                final_results.append(result)

        listed_count = sum(1 for r in final_results if r.get('listed') is True)
        error_count = sum(1 for r in final_results if r.get('error'))

        return {
            'status': 'completed',
            'business_name': business_name,
            'location': location,
            'checked_at': datetime.utcnow().isoformat() + 'Z',
            'results': final_results,
            'summary': {
                'total_checked': len(final_results),
                'listed': listed_count,
                'not_listed': len(final_results) - listed_count - error_count,
                'errors': error_count,
            }
        }

    async def _check_directory(self, key, entry, business_name, location,
                                phone, address, website):
        """Check a single directory using its playbook's verify() function."""
        from playwright.async_api import async_playwright

        module = entry.get('module')
        verify_fn = getattr(module, 'verify', None)

        if not verify_fn:
            return {
                'directory': key,
                'directory_name': entry.get('name', key),
                'listed': None,
                'confidence': 0,
                'error': 'No verify function in playbook',
            }

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(
                    headless=True,
                    args=['--no-sandbox', '--disable-dev-shm-usage',
                          '--disable-blink-features=AutomationControlled']
                )
                context = await browser.new_context(
                    viewport={'width': 1280, 'height': 800},
                    user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                              '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                )
                page = await context.new_page()
                page.set_default_timeout(self.timeout)

                try:
                    # Call the playbook's verify function
                    matches = await verify_fn(page, business_name, location)

                    if not matches:
                        return {
                            'directory': key,
                            'directory_name': entry.get('name', key),
                            'listed': False,
                            'confidence': 90,
                            'listing_url': None,
                            'found_nap': None,
                            'nap_issues': [],
                            'error': None,
                        }

                    # Fuzzy-match results against the business
                    best_match = None
                    best_score = 0

                    for match in matches:
                        match_name = match.get('name', '')
                        name_score = _fuzzy_match(business_name, match_name)

                        # Boost score if phone matches
                        phone_boost = 0
                        if phone and match.get('phone'):
                            if _normalise_phone(phone) == _normalise_phone(match['phone']):
                                phone_boost = 20

                        total_score = min(name_score + phone_boost, 100)

                        if total_score > best_score:
                            best_score = total_score
                            best_match = match

                    is_listed = best_score >= 60

                    # Check NAP consistency
                    nap_issues = []
                    if best_match and is_listed:
                        if phone and best_match.get('phone'):
                            if _normalise_phone(phone) != _normalise_phone(best_match['phone']):
                                nap_issues.append(
                                    f"Phone differs: '{best_match['phone']}' vs '{phone}'"
                                )
                        if address and best_match.get('address'):
                            addr_score = _fuzzy_match(address, best_match['address'])
                            if addr_score < 70:
                                nap_issues.append(
                                    f"Address differs: '{best_match['address']}' vs '{address}'"
                                )

                    return {
                        'directory': key,
                        'directory_name': entry.get('name', key),
                        'listed': is_listed,
                        'confidence': best_score,
                        'listing_url': best_match.get('url') if best_match else None,
                        'found_nap': best_match if is_listed else None,
                        'nap_issues': nap_issues,
                        'error': None,
                    }

                finally:
                    await browser.close()

        except Exception as e:
            logger.error(f"Error checking {key}: {e}")
            return {
                'directory': key,
                'directory_name': entry.get('name', key),
                'listed': None,
                'confidence': 0,
                'error': str(e),
            }


class DirectoryRegistrationSession:
    """
    Interactive browser session for registering a business on a directory.
    Follows the LoginSession pattern from social_extractor.py.

    Lifecycle:
    1. Start session -> navigates to registration page, auto-fills form
    2. Status becomes 'awaiting_review' -> caller sees screenshot
    3. Caller can interact (click, type) for CAPTCHAs or corrections
    4. Caller calls submit -> clicks the submit button
    5. Status becomes 'submitted' or 'failed'
    """

    def __init__(self, session_id, directory_key, nap):
        self.session_id = session_id
        self.directory_key = directory_key
        self.nap = nap  # dict with name, address, phone, website, email, category, description
        self.status = 'pending'  # pending | filling | awaiting_review | submitting | submitted | failed | cancelled
        self.screenshot = None   # JPEG bytes
        self.error = None
        self.action_queue = []
        self._submit_requested = False
        self._lock = threading.Lock()
        self._last_activity = time.time()
        self._cancelled = False
        self._page = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def push_action(self, action):
        with self._lock:
            self.action_queue.append(action)
            self._last_activity = time.time()

    def request_submit(self):
        self._submit_requested = True
        self._last_activity = time.time()

    def cancel(self):
        self._cancelled = True
        self.status = 'cancelled'

    def is_expired(self):
        return time.time() - self._last_activity > 300  # 5 min

    def _run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._async_register())
        except Exception as e:
            logger.error(f"RegistrationSession {self.session_id} error: {e}")
            self.status = 'failed'
            self.error = str(e)
        finally:
            loop.close()

    async def _async_register(self):
        from playwright.async_api import async_playwright
        from src.directory_registry import get_playbook

        playbook = get_playbook(self.directory_key)
        if not playbook:
            self.status = 'failed'
            self.error = f'Playbook not found: {self.directory_key}'
            return

        module = playbook.get('module')
        register_fn = getattr(module, 'register', None)
        submit_fn = getattr(module, 'submit', None)

        if not register_fn:
            self.status = 'failed'
            self.error = f'No register function in playbook: {self.directory_key}'
            return

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=['--no-sandbox', '--disable-dev-shm-usage',
                      '--disable-blink-features=AutomationControlled']
            )
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            self._page = page

            # Screenshot loop
            async def screenshot_loop():
                while not self._cancelled and self.status not in ('submitted', 'failed', 'cancelled'):
                    try:
                        jpg = await page.screenshot(type='jpeg', quality=72)
                        self.screenshot = jpg
                    except Exception:
                        pass
                    await asyncio.sleep(0.15)

            # Action processing loop (same as LoginSession)
            async def action_loop():
                while not self._cancelled and self.status not in ('submitted', 'failed', 'cancelled'):
                    with self._lock:
                        actions = list(self.action_queue)
                        self.action_queue.clear()
                    for action in actions:
                        try:
                            atype = action.get('type')
                            if atype == 'click':
                                await page.mouse.click(action['x'], action['y'])
                            elif atype == 'type':
                                await page.keyboard.type(action.get('text', ''))
                            elif atype == 'key':
                                await page.keyboard.press(action.get('key', ''))
                            elif atype == 'scroll':
                                await page.mouse.wheel(
                                    action.get('deltaX', 0),
                                    action.get('deltaY', 0)
                                )
                        except Exception as e:
                            logger.warning(f"Action failed: {e}")
                    await asyncio.sleep(0.1)

            # Submit watch loop
            async def submit_loop():
                while not self._cancelled and self.status not in ('submitted', 'failed', 'cancelled'):
                    if self._submit_requested:
                        self.status = 'submitting'
                        try:
                            if submit_fn:
                                await submit_fn(page)
                            else:
                                # Default: try common submit patterns
                                for selector in [
                                    'button[type="submit"]',
                                    'input[type="submit"]',
                                    'button:has-text("Submit")',
                                    'button:has-text("Register")',
                                    'button:has-text("Add Listing")',
                                ]:
                                    try:
                                        btn = await page.query_selector(selector)
                                        if btn:
                                            await btn.click()
                                            break
                                    except Exception:
                                        continue
                            await page.wait_for_timeout(3000)
                            # Take final screenshot
                            self.screenshot = await page.screenshot(type='jpeg', quality=72)
                            self.status = 'submitted'
                        except Exception as e:
                            logger.error(f"Submit failed: {e}")
                            self.error = str(e)
                            self.status = 'failed'
                        return
                    await asyncio.sleep(0.2)

            try:
                self.status = 'filling'

                # Call playbook's register function to navigate and fill the form
                await register_fn(page, self.nap)

                # Start background loops
                self.status = 'awaiting_review'
                ss_task = asyncio.create_task(screenshot_loop())
                act_task = asyncio.create_task(action_loop())
                sub_task = asyncio.create_task(submit_loop())

                # Wait until session ends (submit, cancel, or timeout)
                deadline = time.time() + 600  # 10 min max
                while (time.time() < deadline
                       and not self._cancelled
                       and self.status not in ('submitted', 'failed', 'cancelled')):
                    await asyncio.sleep(1)
                    self._last_activity = time.time()

                ss_task.cancel()
                act_task.cancel()
                sub_task.cancel()

                if self.status not in ('submitted', 'cancelled', 'failed'):
                    self.status = 'failed'
                    self.error = 'Session timed out'

            except Exception as e:
                logger.error(f"Registration session error: {e}")
                self.status = 'failed'
                self.error = str(e)
            finally:
                await browser.close()
