"""
Social profile discovery and extraction for LibreCrawl.

Tier 1  — Pure derivation from already-crawled data (JSON-LD sameAs, link rel=me, external links)
Tier 1.5— DuckDuckGo search enrichment for missing platforms
Tier 2  — Playwright headless fetch of public profile pages
Tier 3  — Authenticated fetch using stored session cookies
"""

import asyncio
import threading
import time
import logging
import re
import json
from datetime import datetime
from urllib.parse import urlparse, quote_plus

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

SOCIAL_PLATFORMS = {
    'facebook': {
        'domains': ['facebook.com', 'fb.com'], 'label': 'Facebook', 'icon': '🔵',
        'login_url': 'https://www.facebook.com/login',
        'username_sel': 'input[name="email"]', 'password_sel': 'input[name="pass"]', 'multi_step': False,
    },
    'instagram': {
        'domains': ['instagram.com'], 'label': 'Instagram', 'icon': '📸',
        'login_url': 'https://www.instagram.com/accounts/login/',
        'username_sel': 'input[name="username"]', 'password_sel': 'input[name="password"]', 'multi_step': False,
    },
    'linkedin': {
        'domains': ['linkedin.com'], 'label': 'LinkedIn', 'icon': '💼',
        'login_url': 'https://www.linkedin.com/login',
        'username_sel': 'input[name="session_key"]', 'password_sel': 'input[name="session_password"]', 'multi_step': False,
    },
    'twitter': {
        'domains': ['twitter.com', 'x.com'], 'label': 'X / Twitter', 'icon': '🐦',
        'login_url': 'https://x.com/i/flow/login',
        'username_sel': 'input[autocomplete="username"]', 'password_sel': 'input[name="password"]',
        'multi_step': True, 'next_sel': '[data-testid="LoginForm_Login_Button"], [data-testid="ocfEnterTextNextButton"]',
    },
    'youtube': {
        'domains': ['youtube.com', 'youtu.be'], 'label': 'YouTube', 'icon': '▶️',
        'login_url': 'https://accounts.google.com/signin/v2/identifier?service=youtube',
        'username_sel': 'input[name="identifier"]', 'password_sel': 'input[name="Passwd"]',
        'multi_step': True, 'next_sel': '#identifierNext',
    },
    'tiktok': {
        'domains': ['tiktok.com'], 'label': 'TikTok', 'icon': '🎵',
        'login_url': 'https://www.tiktok.com/login/phone-or-email/email',
        'username_sel': 'input[name="username"]', 'password_sel': 'input[type="password"]', 'multi_step': False,
    },
}

# In-memory login sessions keyed by session_id
_login_sessions = {}

# Shared profile cache: key (url, platform) → {'data': {...}, 'expires': float}
_social_profile_cache = {}


def _get_platform_for_url(url):
    """Return platform key if url matches a known platform domain."""
    try:
        domain = urlparse(url).netloc.lower().lstrip('www.')
        for platform, config in SOCIAL_PLATFORMS.items():
            for d in config['domains']:
                if domain == d or domain.endswith('.' + d):
                    return platform
    except Exception:
        pass
    return None


def _extract_handle(url, platform):
    """Best-effort handle extraction from URL path."""
    try:
        path = urlparse(url).path.strip('/')
        if not path:
            return None
        # Remove query strings, take first segment
        handle = path.split('/')[0].split('?')[0]
        # Skip generic segments
        skip = {'pages', 'groups', 'channel', 'c', 'user', 'company', 'in', 'pub', 'school'}
        parts = path.split('/')
        for part in parts:
            if part and part not in skip:
                return '@' + part
        return '@' + handle if handle else None
    except Exception:
        return None


def discover_social_urls(urls, links):
    """
    Tier 1: Pure derivation from already-crawled data. No HTTP requests.

    Sources (priority order):
    1. JSON-LD sameAs
    2. meta_tags 'me' (link rel=me)
    3. External links matching platform domains

    Returns {platform: {url, handle, source} | None, ...}
    """
    found = {p: None for p in SOCIAL_PLATFORMS}

    # Source 1: JSON-LD sameAs
    for url_item in urls:
        json_ld_raw = url_item.get('json_ld') or url_item.get('json_ld_raw') or []
        if isinstance(json_ld_raw, str):
            try:
                json_ld_raw = json.loads(json_ld_raw)
            except Exception:
                json_ld_raw = []
        if not isinstance(json_ld_raw, list):
            json_ld_raw = [json_ld_raw]

        for entity in json_ld_raw:
            if not isinstance(entity, dict):
                continue
            entity_type = entity.get('@type', '')
            if isinstance(entity_type, list):
                entity_type = ' '.join(entity_type)
            if not any(t in entity_type for t in ['Organization', 'LocalBusiness', 'Corporation', 'Person', 'WebSite']):
                continue
            same_as = entity.get('sameAs', [])
            if isinstance(same_as, str):
                same_as = [same_as]
            for sa_url in same_as:
                platform = _get_platform_for_url(sa_url)
                if platform and found[platform] is None:
                    found[platform] = {
                        'url': sa_url,
                        'handle': _extract_handle(sa_url, platform),
                        'source': 'sameAs'
                    }

    # Source 2: link rel=me (stored in meta_tags)
    for url_item in urls:
        meta_tags = url_item.get('meta_tags') or {}
        if isinstance(meta_tags, str):
            try:
                meta_tags = json.loads(meta_tags)
            except Exception:
                meta_tags = {}
        me_links = meta_tags.get('me', [])
        if isinstance(me_links, str):
            me_links = [me_links]
        for me_url in me_links:
            platform = _get_platform_for_url(me_url)
            if platform and found[platform] is None:
                found[platform] = {
                    'url': me_url,
                    'handle': _extract_handle(me_url, platform),
                    'source': 'link_rel_me'
                }

    # Source 3: External links
    for link in links:
        target = link.get('target_url') or link.get('url') or ''
        platform = _get_platform_for_url(target)
        if platform and found[platform] is None:
            found[platform] = {
                'url': target,
                'handle': _extract_handle(target, platform),
                'source': 'external_link'
            }

    return found


def _extract_business_name(urls):
    """Extract best business name from crawled data."""
    org_types = {'Organization', 'LocalBusiness', 'Corporation', 'Person', 'WebSite'}

    # Priority 1: JSON-LD entity with name + business type
    for url_item in urls:
        json_ld_raw = url_item.get('json_ld') or url_item.get('json_ld_raw') or []
        if isinstance(json_ld_raw, str):
            try:
                json_ld_raw = json.loads(json_ld_raw)
            except Exception:
                json_ld_raw = []
        if not isinstance(json_ld_raw, list):
            json_ld_raw = [json_ld_raw]
        for entity in json_ld_raw:
            if not isinstance(entity, dict):
                continue
            entity_type = entity.get('@type', '')
            if isinstance(entity_type, list):
                entity_type = ' '.join(entity_type)
            if any(t in entity_type for t in org_types):
                name = entity.get('name', '').strip()
                if name:
                    return name

    # Priority 2: og:site_name
    for url_item in urls:
        meta_tags = url_item.get('meta_tags') or {}
        if isinstance(meta_tags, str):
            try:
                meta_tags = json.loads(meta_tags)
            except Exception:
                meta_tags = {}
        og_tags = url_item.get('og_tags') or meta_tags.get('og', {}) or {}
        if isinstance(og_tags, str):
            try:
                og_tags = json.loads(og_tags)
            except Exception:
                og_tags = {}
        site_name = og_tags.get('site_name', '').strip()
        if site_name:
            return site_name

    # Priority 3: Home page title (cleaned)
    for url_item in urls:
        title = (url_item.get('title') or '').strip()
        if title:
            # Strip common suffixes
            for sep in [' | ', ' - ', ' – ', ' — ', ' :: ']:
                if sep in title:
                    title = title.split(sep)[0].strip()
            # Remove generic suffixes
            for suffix in [' Home', ' Official Site', ' Official Website', ' Homepage']:
                if title.endswith(suffix):
                    title = title[:-len(suffix)].strip()
            if title:
                return title

    # Priority 4: First h1 on home page
    for url_item in urls:
        h1 = (url_item.get('h1') or '').strip()
        if h1:
            return h1

    return ''


def search_for_social_profile(business_name, domain, platform):
    """
    Tier 1.5: DuckDuckGo search when Tier 1 finds no link for a platform.
    Returns {url, handle, source: 'web_search'} or None.
    """
    config = SOCIAL_PLATFORMS.get(platform, {})
    target_domains = config.get('domains', [])
    if not target_domains:
        return None

    primary_domain = target_domains[0]
    queries = []
    if business_name:
        queries.append(f'site:{primary_domain} "{business_name}"')
    if domain:
        queries.append(f'"{domain}" site:{primary_domain}')

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }

    for query in queries:
        try:
            search_url = f'https://html.duckduckgo.com/html/?q={quote_plus(query)}'
            resp = requests.get(search_url, headers=headers, timeout=10)
            if resp.status_code != 200:
                continue
            soup = BeautifulSoup(resp.text, 'html.parser')
            for a in soup.select('a.result__url, a.result__a, .result__url'):
                href = a.get('href', '')
                # DDG wraps URLs, try to extract real URL
                if 'uddg=' in href:
                    from urllib.parse import unquote, parse_qs, urlparse as up
                    qs = parse_qs(up(href).query)
                    uddg = qs.get('uddg', [''])[0]
                    if uddg:
                        href = unquote(uddg)
                plat = _get_platform_for_url(href)
                if plat == platform:
                    return {
                        'url': href,
                        'handle': _extract_handle(href, platform),
                        'source': 'web_search'
                    }
        except Exception as e:
            logger.warning(f"Social search failed for {platform}: {e}")
            continue

    return None


def _fb_resolve_url(html, original_url):
    """If html is a personal profile with a delegate_page_id, return the Page URL instead."""
    if not html:
        return original_url
    m = re.search(r'delegate_page_id[\\\"]*\s*:\s*[\\\"]*(\d{10,})', html)
    if m:
        page_id = m.group(1)
        parsed = urlparse(original_url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        return f"{base}/profile.php?id={page_id}"
    return original_url


def _fb_about_url(url):
    """Derive the Facebook ?sk=about URL from a profile/page URL."""
    try:
        parsed = urlparse(url)
        if 'sk=about' in parsed.query or parsed.path.rstrip('/').endswith('/about'):
            return url
        if parsed.path.startswith('/profile.php') or 'id=' in parsed.query:
            sep = '&' if parsed.query else '?'
            return url.rstrip('&') + sep + 'sk=about'
        path = parsed.path.rstrip('/')
        return parsed._replace(path=path + '/about', query='', fragment='').geturl()
    except Exception:
        return url + '?sk=about'


async def _fetch_fb_pages(url, cookies=None):
    """
    1. Fetch original URL to detect delegate_page_id.
    2. If found, resolve to the actual Page URL.
    3. Fetch resolved main page + ?sk=about in parallel.
    Returns (main_html, about_html).
    """
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=[
                '--no-sandbox', '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled', '--disable-infobars',
            ])
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            await context.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
            )
            if cookies:
                await context.add_cookies(cookies)

            # Step 1: fetch original URL to check for delegate_page_id
            probe = await context.new_page()
            try:
                await probe.goto(url, wait_until='domcontentloaded', timeout=20000)
            except Exception:
                pass
            await probe.wait_for_timeout(4000)
            probe_html = await probe.content()
            await probe.close()

            # Step 2: resolve to actual page URL if needed
            resolved_url = _fb_resolve_url(probe_html, url)
            about_url = _fb_about_url(resolved_url)

            # Step 3: parallel fetch of main + about
            page_main  = await context.new_page()
            page_about = await context.new_page()

            async def _load(page, target):
                try:
                    await page.goto(target, wait_until='domcontentloaded', timeout=20000)
                except Exception:
                    pass
                await page.wait_for_timeout(5000)
                return await page.content()

            results = await asyncio.gather(
                _load(page_main, resolved_url),
                _load(page_about, about_url),
                return_exceptions=True
            )
            await browser.close()

            main_html  = results[0] if not isinstance(results[0], Exception) else None
            about_html = results[1] if not isinstance(results[1], Exception) else None
            return (main_html, about_html)

    except Exception as e:
        logger.warning(f"_fetch_fb_pages failed for {url}: {e}")
        return (None, None)


async def _run_playwright_fetch(url, cookies=None):
    """Async Playwright fetch with anti-bot args."""
    try:
        from playwright.async_api import async_playwright
        is_facebook = 'facebook.com' in url or 'fb.com' in url
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                ]
            )
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            await context.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
            )
            if cookies:
                await context.add_cookies(cookies)
            page = await context.new_page()
            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=20000)
            except Exception:
                pass
            await page.wait_for_timeout(5000 if is_facebook else 2000)
            html = await page.content()
            await browser.close()
            return html
    except Exception as e:
        logger.warning(f"Playwright fetch failed for {url}: {e}")
        return None


def _parse_profile(html, platform, extra_html=None):
    """Parse profile HTML for OG tags and platform-specific data."""
    if not html:
        return {}
    try:
        soup = BeautifulSoup(html, 'html.parser')
        data = {}

        # Universal OG tags
        for meta in soup.find_all('meta', property=re.compile(r'^og:')):
            key = meta.get('property', '').replace('og:', '')
            val = meta.get('content', '').strip()
            if key and val:
                data[key] = val

        # Strip notification-count prefix from og:title e.g. "(20+) Facebook" or "(4) LinkedIn"
        if 'title' in data:
            data['title'] = re.sub(r'^\(\d+\+?\)\s+', '', data['title'])

        # Platform-specific extraction
        if platform == 'instagram':
            # Bio / follower count from meta description
            desc = data.get('description', '')
            m = re.search(r'([\d,.KkMm]+)\s*Followers', desc)
            if m:
                data['followers'] = m.group(1)
            m = re.search(r'([\d,.KkMm]+)\s*Posts', desc)
            if m:
                data['posts'] = m.group(1)
            # Website in bio
            for a in soup.find_all('a', href=True):
                href = a['href']
                if 'l.instagram.com' in href or (href.startswith('http') and 'instagram.com' not in href):
                    data.setdefault('website', href)

        elif platform == 'linkedin':
            # Company name: H1 is reliable on both public and admin dashboard pages
            h1_el = soup.find('h1')
            if h1_el:
                name = h1_el.get_text(strip=True)
                if name and len(name) > 1:
                    data.setdefault('title', name)
            # Title fallback: clean up "<title>" tag
            if 'title' not in data:
                title_tag = soup.find('title')
                if title_tag:
                    t = re.sub(r'^\(\d+\+?\)\s+', '', title_tag.get_text(strip=True))
                    t = re.sub(r'\s*[|:]\s*(Company Page Admin|LinkedIn)\s*$', '', t, flags=re.IGNORECASE)
                    t = re.sub(r'\s*\|\s*LinkedIn\s*$', '', t, flags=re.IGNORECASE).strip()
                    if t and t.lower() not in ('linkedin', ''):
                        data['title'] = t
            # If og:title was something useful but got stripped, prefer H1
            raw = str(soup)
            # Tagline / about: try CSS selectors first, then embedded JSON
            for el in soup.select('.top-card-layout__headline, .org-top-card-summary__tagline'):
                text = el.get_text(strip=True)
                if text:
                    data.setdefault('about', text)
                    break
            if not data.get('about'):
                for el in soup.select('.core-section-container__content p'):
                    text = el.get_text(strip=True)
                    if text:
                        data['about'] = text[:500]
                        break
            # Tagline from JSON (present on admin dashboard)
            if not data.get('about'):
                m = re.search(r'"tagline"\s*:\s*"([^"]{5,300})"', raw)
                if m:
                    data['about'] = m.group(1)
            if not data.get('about'):
                m = re.search(r'"description"\s*:\s*"([^"]{10,400})"', raw)
                if m:
                    data['about'] = m.group(1)[:400]
            # Follower count — sanity-check: ignore values < 10 (likely wrong field) and > 50M (platform totals)
            for pat in [r'"numFollowers"\s*:\s*(\d+)', r'"followerCount"\s*:\s*(\d+)']:
                m = re.search(pat, raw)
                if m:
                    count = int(m.group(1))
                    if 10 <= count < 50_000_000:
                        data['followers'] = str(count)
                        break

        elif platform == 'facebook':
            # og:title for authenticated FB is generic ("Facebook") — discard
            if data.get('title', '').lower() in ('facebook', ''):
                data.pop('title', None)
            # Name: H1 is most reliable
            h1_el = soup.find('h1')
            if h1_el:
                name = h1_el.get_text(strip=True)
                if name and len(name) > 1 and name.lower() != 'facebook':
                    data['title'] = name
            if 'title' not in data:
                title_tag = soup.find('title')
                if title_tag:
                    t = re.sub(r'^\(\d+\+?\)\s+', '', title_tag.get_text(strip=True))
                    t = re.sub(r'\s*[|\-–]\s*Facebook\s*$', '', t).strip()
                    if t and t.lower() != 'facebook':
                        data['title'] = t
            # Profile image: first Facebook CDN image
            if 'image' not in data:
                for img in soup.find_all('img'):
                    src = img.get('src', '')
                    if src and ('scontent' in src or 'fbcdn.net' in src) and 'rsrc.php' not in src:
                        data['image'] = src
                        break
            # Description fallback
            if 'description' not in data:
                desc_meta = soup.find('meta', attrs={'name': 'description'})
                if desc_meta:
                    data['description'] = desc_meta.get('content', '')

            # Use plain text for rendered-DOM fields (followers, likes, category)
            plain = soup.get_text('\n')
            raw = str(soup)
            logger.warning(f"[FB] plain (first 1500):\n{plain[:1500]}")

            # Followers — "3.8K followers" / "3.8K\nfollowers" / JSON
            for pat in [
                r'([\d.,]+[KkMm]?)\s*\nfollowers',   # newline-separated
                r'([\d.,]+[KkMm]?)\s+followers',       # space-separated
                r'"follower_count"\s*:\s*(\d+)',        # JSON key
                r'"followers_count"\s*:\s*(\d+)',
                r'followers[^<]{0,30}?([\d.,]+[KkMm]?)',  # text reversed order
            ]:
                m = re.search(pat, plain if 'follower' not in pat or 'JSON' in pat else plain, re.IGNORECASE)
                if not m:
                    m = re.search(pat, raw, re.IGNORECASE)
                if m:
                    data['followers'] = m.group(1)
                    logger.warning(f"[FB] followers matched '{pat}': {m.group(1)}")
                    break

            # Likes — "3.5K likes" / "3.5K\nlikes"
            for pat in [
                r'([\d.,]+[KkMm]?)\s*\nlikes',
                r'([\d.,]+[KkMm]?)\s+likes',
                r'"page_likers"[^}]*?"count"\s*:\s*(\d+)',
            ]:
                m = re.search(pat, plain, re.IGNORECASE)
                if not m:
                    m = re.search(pat, raw, re.IGNORECASE)
                if m:
                    data['likes'] = m.group(1)
                    break

            # Category — try HTML first, fallback to plain text
            cat_m = re.search(r'>([A-Za-z][^<>]{2,50})</[a-z]+>\s*(?:<[^>]+>)*\s*More\b', raw)
            if cat_m:
                cat = cat_m.group(1).strip()
                if cat.lower() not in ('more', 'like', 'follow', 'message', 'share', 'facebook'):
                    data['category'] = cat
            if not data.get('category'):
                # plain text: category sits between followers/likes and "More" button
                for cat_pat in [
                    r'(?:followers|likes)\n([\w &/,\-]{3,60})\n(?:More|WhatsApp|Message|Share)',
                    r'(?:followers|likes)\s+([\w &/,\-]{3,60})\s+(?:More|WhatsApp|Message|Share)',
                ]:
                    cat_txt = re.search(cat_pat, plain, re.IGNORECASE)
                    if cat_txt:
                        data['category'] = cat_txt.group(1).strip()
                        break

            # Bio / about — modern FB JSON: "text":"...","field_type":"bio"
            # Also try reversed order (field_type before text in some encodings)
            for bio_pat in [
                r'"text"\s*:\s*"([^"]{5,}?)"\s*,\s*"field_type"\s*:\s*"bio"',
                r'"field_type"\s*:\s*"bio"\s*,\s*"text"\s*:\s*"([^"]{5,}?)"',
                r'"biography"\s*:\s*"([^"]{5,}?)"',
            ]:
                m = re.search(bio_pat, raw)
                if m:
                    data['about'] = m.group(1)[:400]
                    break

            # Rating — "4.5 out of 5" or legacy JSON
            m = re.search(r'([\d.]+)\s+out\s+of\s+5', plain, re.IGNORECASE)
            if not m:
                m = re.search(r'"overall_star_rating"\s*:\s*([\d.]+)', raw)
            if m:
                try:
                    val = float(m.group(1))
                    if 0.0 < val <= 5.0:
                        data['rating'] = str(round(val, 1))
                except ValueError:
                    pass

            # Rating count — "(NNN reviews)" in plain text
            m = re.search(r'\((\d[\d,]*)\s+reviews?\)', plain, re.IGNORECASE)
            if not m:
                m = re.search(r'"rating_count"\s*:\s*(\d+)', raw)
            if m:
                data['rating_count'] = m.group(1).replace(',', '')

            # --- From MAIN PAGE rendered HTML (Details sidebar) ---
            from urllib.parse import unquote as _unquote

            # Website: find external links in the rendered main page
            if not data.get('website'):
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if 'l.facebook.com/l.php' in href or 'l.php?u=' in href:
                        lm = re.search(r'[?&]u=(https?://[^&]+)', href)
                        if lm:
                            href = _unquote(lm.group(1))
                    if href.startswith('http') and not any(
                        d in href for d in ('facebook.com', 'fbcdn.net', 'fb.com', 'fb.me', 'instagram.com')
                    ):
                        data['website'] = href.rstrip('.,)')
                        logger.warning(f"[FB] website from main page link: {href}")
                        break

            # Phone: rendered HTML text like ">012 023 1134<"
            if not data.get('phone'):
                for phone_pat in [
                    r'>\s*(\+?0\d{2}[\s\u00a0]\d{3}[\s\u00a0]\d{4})\s*<',   # SA: 012 023 1134
                    r'>\s*(\+?1[\s\-\.]\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})\s*<',  # US
                    r'>\s*(\+\d{1,3}[\s\-\.]\d{3,4}[\s\-\.]\d{3,4}[\s\-\.]\d{2,4})\s*<',  # intl
                    r'>\s*(\(\d{2,4}\)[\s\-\.\u00a0]\d{3,4}[\s\-\.\u00a0]\d{3,4})\s*<',   # (012) 023 1134
                    r'>\s*(\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4})\s*<',            # generic 10-digit
                ]:
                    m = re.search(phone_pat, raw)
                    if m:
                        data['phone'] = m.group(1).strip()
                        logger.warning(f"[FB] phone from main page: {data['phone']}")
                        break

            # Address: find the full street address in rendered HTML text
            if not data.get('address'):
                # Look for a text node that starts with a street number
                addr_m = re.search(
                    r'>\s*(\d+\s+[A-Z][a-zA-Z\u00c0-\u017e\s,\.]{15,120}\d{4,5})\s*<', raw
                )
                if addr_m:
                    data['address'] = addr_m.group(1).strip()
                    logger.warning(f"[FB] address from main page: {data['address']}")

            # About text from header intro ("ALL YOUR DENTAL NEEDS")
            if not data.get('about'):
                # Intro text appears between page name and category in the header
                intro_m = re.search(
                    r'>[A-Z][A-Z\s]{5,200}</[a-z]+>',   # all-caps intro text like "ALL YOUR DENTAL NEEDS"
                    raw
                )
                if intro_m:
                    candidate = re.sub(r'<[^>]+>', '', intro_m.group(0)).strip()
                    if 5 < len(candidate) < 300 and candidate.upper() == candidate:
                        data['about'] = candidate

            # External links list from main page (all non-FB external hrefs)
            if not data.get('links'):
                seen_links, collected = set(), []
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if 'l.facebook.com/l.php' in href or 'l.php?u=' in href:
                        lm = re.search(r'[?&]u=(https?://[^&]+)', href)
                        if lm:
                            href = _unquote(lm.group(1))
                    if not href.startswith('http'):
                        continue
                    if any(d in href for d in ('facebook.com', 'fbcdn.net', 'fb.com', 'fb.me', 'instagram.com')):
                        continue
                    norm = href.rstrip('/').split('?')[0]
                    if norm not in seen_links:
                        seen_links.add(norm)
                        collected.append(href)
                    if len(collected) >= 10:
                        break
                if collected:
                    data['links'] = collected

            # --- From about page (extra_html) ---
            logger.warning(f"[FB] extra_html present: {bool(extra_html)}, len={len(extra_html) if extra_html else 0}")
            if extra_html:
                about_soup = BeautifulSoup(extra_html, 'html.parser')
                about_raw   = str(about_soup)
                about_plain = about_soup.get_text('\n')
                logger.warning(f"[FB] about plain (first 500):\n{about_plain[:500]}")
                for needle in ('"phone"', '"website"', '"external_url"', 'field_type', '"address"', '"city"'):
                    idx = about_raw.find(needle)
                    if idx != -1:
                        logger.warning(f"[FB] snippet '{needle}' @{idx}: ...{about_raw[max(0,idx-30):idx+250]}...")

                # Intro (field_type:"intro" JSON pattern)
                m = re.search(r'"text"\s*:\s*"([^"]{5,}?)"\s*,\s*"field_type"\s*:\s*"intro"', about_raw)
                if m:
                    data['intro'] = m.group(1)[:500]

                # Email
                m = re.search(r'"email"\s*:\s*"([^"@]{1,50}@[^"]{3,})"', about_raw)
                if not m:
                    m = re.search(r'([\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,})', about_plain)
                if m:
                    e = m.group(1)
                    if '@' in e and '.' in e.split('@')[-1] and 'facebook' not in e:
                        data['email'] = e

                # Website (explicit website field in JSON)
                m = re.search(r'"website"\s*:\s*"(https?://[^"]+)"', about_raw)
                if not m:
                    m = re.search(r'"external_url"\s*:\s*"(https?://[^"]+)"', about_raw)
                if m:
                    site = m.group(1)
                    if 'facebook.com' not in site and 'fb.com' not in site:
                        data['website'] = site
                # Fallback: first non-FB external link in about plain text
                if not data.get('website'):
                    for lnk in re.findall(r'https?://[^\s<>"\']{8,}', about_plain):
                        if 'facebook.com' not in lnk and 'fbcdn.net' not in lnk:
                            data['website'] = lnk.rstrip('.,)')
                            break

                # Phone — in JSON or plain text
                m = re.search(r'"\s*(\+?[\d\s\-\(\).]{7,20})\s*"\s*,\s*"field_type"\s*:\s*"phone"', about_raw)
                if not m:
                    m = re.search(r'"phone"\s*:\s*"([^"]+)"', about_raw)
                if m:
                    data['phone'] = m.group(1).strip()

                # Address
                m = re.search(r'"text"\s*:\s*"([^"]{5,150})"\s*,\s*"field_type"\s*:\s*"address"', about_raw)
                if not m:
                    m = re.search(r'"city_name"\s*:\s*"([^"]+)"', about_raw)
                if m:
                    data['address'] = m.group(1)

                # Price range
                m = re.search(r'"price_range"\s*:\s*"([^"]+)"', about_raw)
                if not m:
                    m = re.search(r'Price\s+range[:\s]+([^\n<]{1,20})', about_plain, re.IGNORECASE)
                if m:
                    data['price_range'] = m.group(1).strip()

                # External links (unwrap FB redirect, deduplicate)
                from urllib.parse import unquote as _unquote
                seen, links = set(), []
                for a in about_soup.find_all('a', href=True):
                    href = a['href']
                    if 'l.facebook.com/l.php' in href or 'l.php?u=' in href:
                        lm = re.search(r'[?&]u=(https?://[^&]+)', href)
                        if lm:
                            href = _unquote(lm.group(1))
                    if not href.startswith('http'):
                        continue
                    if any(d in href for d in ('facebook.com', 'fb.com', 'fb.me',
                                               'instagram.com', 'fbcdn.net')):
                        continue
                    norm = href.rstrip('/').split('?')[0]
                    if norm not in seen:
                        seen.add(norm)
                        links.append(href)
                    if len(links) >= 10:
                        break
                if links:
                    data['links'] = links

        elif platform == 'youtube':
            # Subscriber count from meta
            for meta in soup.find_all('meta', itemprop='subscriberCount'):
                data['subscribers'] = meta.get('content', '')

        logger.warning(f"[FB] _parse_profile({platform}) final keys: {list(data.keys())}")
        return data
    except Exception as e:
        logger.warning(f"Profile parse failed for {platform}: {e}")
        return {}


def fetch_social_profile(url, platform, cookies=None):
    """Sync wrapper: Tier 2/3 fetch + parse."""
    try:
        loop = asyncio.new_event_loop()
        if platform == 'facebook':
            main_html, about_html = loop.run_until_complete(
                _fetch_fb_pages(url, cookies)
            )
            loop.close()
            if main_html:
                return _parse_profile(main_html, platform, extra_html=about_html)
        else:
            html = loop.run_until_complete(_run_playwright_fetch(url, cookies))
            loop.close()
            if html:
                return _parse_profile(html, platform)
    except Exception as e:
        logger.warning(f"fetch_social_profile failed for {platform} {url}: {e}")
    return {}


def build_social_report(urls, links, fetch_profiles=False, session_cookies=None):
    """
    Orchestrate all tiers and build the full social report.
    """
    if session_cookies is None:
        session_cookies = {}

    business_name = _extract_business_name(urls)
    domain = ''
    if urls:
        try:
            domain = urlparse(urls[0].get('url', '')).netloc.lstrip('www.')
        except Exception:
            pass

    # Tier 1
    tier1 = discover_social_urls(urls, links)
    profiles = {}

    found_on_site = []
    found_via_search = []
    missing = []
    has_schema_same_as = False

    for platform, result in tier1.items():
        if result:
            profiles[platform] = dict(result, data=None)
            found_on_site.append(platform)
            if result.get('source') == 'sameAs':
                has_schema_same_as = True
        else:
            profiles[platform] = None

    # Tier 1.5: search for missing platforms
    for platform in list(profiles.keys()):
        if profiles[platform] is None:
            search_result = search_for_social_profile(business_name, domain, platform)
            if search_result:
                profiles[platform] = dict(search_result, data=None)
                found_via_search.append(platform)
            else:
                missing.append(platform)

    # Tier 2/3: Playwright fetch
    if fetch_profiles:
        import random as _random
        first = True
        for platform, profile in profiles.items():
            if profile and profile.get('url'):
                if not first:
                    time.sleep(_random.uniform(1.0, 2.5))   # human-like pacing
                first = False
                cookies_for_platform = session_cookies.get(platform)
                profile_data = fetch_social_profile(
                    profile['url'], platform, cookies=cookies_for_platform
                )
                profiles[platform]['data'] = profile_data

    return {
        'profiles': profiles,
        'business_name': business_name,
        'summary': {
            'found_on_site': found_on_site,
            'found_via_search': found_via_search,
            'missing': missing,
            'has_schema_sameAs': has_schema_same_as,
        },
        'analyzed_at': datetime.utcnow().isoformat() + 'Z',
    }


class LoginSession:
    """
    Tier 3: In-browser login automation with screenshot relay.
    Spawns a daemon thread with its own asyncio loop.
    """

    def __init__(self, session_id, platform, username=None, password=None):
        self.session_id = session_id
        self.platform = platform
        self.username = username
        self.password = password
        self.status = 'pending'   # pending | running | awaiting_input | success | failed | cancelled
        self.cookies = []
        self.handle = None
        self.screenshot = None    # PNG bytes
        self.action_queue = []
        self._lock = threading.Lock()
        self._last_activity = time.time()
        self._cancelled = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def push_action(self, action):
        with self._lock:
            self.action_queue.append(action)
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
            loop.run_until_complete(self._async_login())
        except Exception as e:
            logger.error(f"LoginSession {self.session_id} error: {e}")
            self.status = 'failed'
        finally:
            loop.close()

    async def _async_login(self):
        from playwright.async_api import async_playwright
        config = SOCIAL_PLATFORMS.get(self.platform, {})
        login_url = config.get('login_url', '')

        # Platforms that block headless Chromium — use Firefox instead
        _firefox_platforms = {'twitter', 'instagram'}

        async with async_playwright() as p:
            if self.platform in _firefox_platforms:
                browser = await p.firefox.launch(headless=True)
                context = await browser.new_context(
                    viewport={'width': 1280, 'height': 800},
                    user_agent='Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0'
                )
            else:
                browser = await p.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--no-first-run',
                        '--no-default-browser-check',
                    ]
                )
                context = await browser.new_context(
                    viewport={'width': 1280, 'height': 800},
                    user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                )
            page = await context.new_page()
            # Patch navigator.webdriver to avoid bot detection
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )

            # Screenshot loop task
            async def screenshot_loop():
                while not self._cancelled and self.status not in ('success', 'failed', 'cancelled'):
                    try:
                        jpg = await page.screenshot(type='jpeg', quality=72)
                        self.screenshot = jpg
                    except Exception:
                        pass
                    await asyncio.sleep(0.15)

            # Action processing loop task
            async def action_loop():
                while not self._cancelled and self.status not in ('success', 'failed', 'cancelled'):
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
                        except Exception as e:
                            logger.warning(f"Action failed: {e}")
                    await asyncio.sleep(0.1)

            async def _type_into(selector, text, timeout=10000):
                """Click a field and type into it character-by-character so React onChange fires."""
                await page.wait_for_selector(selector, timeout=timeout)
                await page.click(selector)
                await page.wait_for_timeout(150)
                # Clear existing content then type
                await page.keyboard.press('Control+a')
                await page.keyboard.type(text, delay=40)
                await page.wait_for_timeout(200)

            self.status = 'running'
            try:
                # Twitter's SPA needs networkidle; others are fine with domcontentloaded
                wait_until = 'networkidle' if self.platform == 'twitter' else 'domcontentloaded'
                load_timeout = 25000 if self.platform == 'twitter' else 15000
                await page.goto(login_url, wait_until=wait_until, timeout=load_timeout)
                await page.wait_for_timeout(1200)

                # Start screenshot/action loops immediately so user sees the browser at all times
                self.status = 'awaiting_input'
                ss_task = asyncio.create_task(screenshot_loop())
                act_task = asyncio.create_task(action_loop())

                # Auto-fill credentials if provided
                if self.username and config.get('username_sel'):
                    try:
                        await _type_into(config['username_sel'], self.username)
                    except Exception as e:
                        logger.warning(f"Could not fill username for {self.platform}: {e}")

                if config.get('multi_step') and self.username and config.get('next_sel'):
                    try:
                        await page.wait_for_selector(config['next_sel'], timeout=4000)
                        await page.click(config['next_sel'])
                        await page.wait_for_timeout(1500)
                    except Exception as e:
                        logger.warning(f"Could not advance to password step for {self.platform}: {e}")

                if self.password and config.get('password_sel'):
                    try:
                        await _type_into(config['password_sel'], self.password)
                    except Exception as e:
                        logger.warning(f"Could not fill password for {self.platform}: {e}")
                # Wait for URL change indicating successful login (2 min timeout)
                deadline = time.time() + 120
                login_url_base = login_url.split('?')[0]
                while time.time() < deadline and not self._cancelled:
                    current_url = page.url
                    blocked = (
                        login_url_base in current_url
                        or 'login' in current_url.lower()
                        or 'signin' in current_url.lower()
                        or 'accounts.google.com' in current_url
                        or 'checkpoint' in current_url.lower()
                        or 'challenge' in current_url.lower()
                        or 'verify' in current_url.lower()
                        or 'two-step' in current_url.lower()
                        or 'two_step' in current_url.lower()
                        or 'two_factor' in current_url.lower()
                        or 'two-factor' in current_url.lower()
                        or 'security' in current_url.lower()
                        or 'captcha' in current_url.lower()
                        or 'authentication' in current_url.lower()
                        or '/2fa' in current_url.lower()
                        or '/i/flow/' in current_url.lower()
                        or 'account/access' in current_url.lower()
                        or 'account/suspended' in current_url.lower()
                    )
                    if not blocked:
                        self.status = 'success'
                        self.cookies = await context.cookies()
                        try:
                            self.handle = _extract_handle(current_url, self.platform)
                        except Exception:
                            pass
                        break
                    await asyncio.sleep(1)
                    self._last_activity = time.time()
                ss_task.cancel()
                act_task.cancel()
                if self.status != 'success' and not self._cancelled:
                    self.status = 'failed'
            except Exception as e:
                logger.error(f"Login session error for {self.platform}: {e}")
                self.status = 'failed'
            finally:
                await browser.close()
