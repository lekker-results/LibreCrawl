"""SEO Keyword Extraction Engine for LibreCrawl"""
import re
import json
import math
from collections import defaultdict


STOPWORDS = {
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'it', 'its', 'he', 'she', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'mine',
    'yours', 'hers', 'ours', 'theirs', 'this', 'that', 'these', 'those',
    'i', 'you', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'because', 'if', 'then', 'else',
    'while', 'about', 'up', 'out', 'off', 'over', 'under', 'again',
    'further', 'once', 'here', 'there', 'any', 'also', 'after', 'before',
    'above', 'below', 'between', 'through', 'during', 'into', 'itself',
    'myself', 'yourself', 'himself', 'herself', 'ourselves', 'themselves',
    'am', 'being', 'having', 'doing', 'get', 'got', 'gets', 'getting',
    'let', 'lets', 'make', 'makes', 'made', 'go', 'goes', 'gone', 'going',
    'come', 'comes', 'came', 'coming', 'take', 'takes', 'took', 'taken',
    'see', 'seen', 'saw', 'know', 'known', 'knew', 'think', 'thought',
    'say', 'said', 'tell', 'told', 'give', 'gave', 'given', 'find',
    'found', 'want', 'well', 'back', 'even', 'new', 'now', 'way', 'like',
    'much', 'many', 'still', 'since', 'long', 'right', 'set', 'put',
    'yet', 'however', 'although', 'though', 'whether', 'either', 'neither',
    'per', 'via', 'vs', 'etc', 'ie', 'eg', 'http', 'https', 'www', 'com',
    'org', 'net', 'html', 'css', 'page', 'site', 'click', 'read', 'home',
    'contact', 'menu', 'skip', 'main', 'content', 'search', 'close',
    'open', 'next', 'previous', 'first', 'last', 'nbsp'
}

# Weights for different SEO text sources
SOURCE_WEIGHTS = {
    'title': 3.0,
    'h1': 2.5,
    'meta_description': 2.0,
    'keywords': 2.0,
    'h2': 1.5,
    'anchor_text': 1.5,
    'h3': 1.0,
    'alt_text': 0.8,
}


def tokenize(text):
    """Lowercase, strip punctuation, split on whitespace"""
    if not text:
        return []
    text = text.lower()
    text = re.sub(r'[^\w\s-]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text.split()


def filter_stopwords(tokens):
    """Remove stopwords, single chars, and pure numbers"""
    return [t for t in tokens if t not in STOPWORDS and len(t) > 1 and not t.isdigit()]


def extract_ngrams(tokens, n=2):
    """Extract bigrams from a token list"""
    ngrams = []
    for i in range(len(tokens) - n + 1):
        ngram = ' '.join(tokens[i:i + n])
        ngrams.append(ngram)
    return ngrams


def _extract_fields_from_url(url_data):
    """Extract weighted text fields from a single URL's crawl data."""
    fields = []

    title = url_data.get('title', '')
    if title:
        fields.append(('title', title))

    h1 = url_data.get('h1', '')
    if h1:
        fields.append(('h1', h1))

    meta_desc = url_data.get('meta_description', '')
    if meta_desc:
        fields.append(('meta_description', meta_desc))

    keywords = url_data.get('keywords', '')
    if keywords:
        fields.append(('keywords', keywords))

    for h2 in url_data.get('h2', []):
        if h2:
            fields.append(('h2', h2))

    for h3 in url_data.get('h3', []):
        if h3:
            fields.append(('h3', h3))

    for img in url_data.get('images', []):
        alt = img.get('alt', '')
        if alt:
            fields.append(('alt_text', alt))

    return fields


def _get_anchor_texts(links):
    """Extract internal anchor texts from link data."""
    texts = []
    for link in links:
        anchor = link.get('anchor_text', '')
        if anchor and len(anchor) > 1 and not anchor.startswith('http'):
            texts.append(anchor)
    return texts


def extract_keywords(urls, links, limit=50):
    """
    Extract top SEO keywords from crawl data.

    Args:
        urls: list of crawled URL data dicts
        links: list of link data dicts
        limit: max keywords to return

    Returns:
        list of dicts with keyword, score, frequency, pages, sources
    """
    if not urls:
        return []

    # token_data[keyword] = {frequency, pages: set, sources: set, weighted_score, source_scores}
    token_data = defaultdict(lambda: {
        'frequency': 0,
        'pages': set(),
        'sources': set(),
        'weighted_score': 0.0,
        'source_scores': defaultdict(float),
    })

    # Build anchor text lookup by target URL
    anchor_by_target = defaultdict(list)
    for link in (links or []):
        anchor = link.get('anchor_text', '')
        target = link.get('target_url', '')
        if anchor and target and len(anchor) > 1 and not anchor.startswith('http'):
            anchor_by_target[target].append(anchor)

    # Process each URL
    for page_idx, url_data in enumerate(urls):
        page_url = url_data.get('url', f'page_{page_idx}')

        # Get standard fields
        fields = _extract_fields_from_url(url_data)

        # Add anchor texts for links pointing to this page
        for anchor in anchor_by_target.get(page_url, []):
            fields.append(('anchor_text', anchor))

        # Process each field
        for source, text in fields:
            weight = SOURCE_WEIGHTS.get(source, 1.0)
            tokens = filter_stopwords(tokenize(text))

            # Unigrams
            for token in tokens:
                td = token_data[token]
                td['frequency'] += 1
                td['pages'].add(page_url)
                td['sources'].add(source)
                td['weighted_score'] += weight
                td['source_scores'][source] += weight

            # Bigrams
            for bigram in extract_ngrams(tokens, 2):
                td = token_data[bigram]
                td['frequency'] += 1
                td['pages'].add(page_url)
                td['sources'].add(source)
                td['weighted_score'] += weight
                td['source_scores'][source] += weight

    return calculate_scores(token_data, limit)


def calculate_scores(token_data, limit=50):
    """Score and rank keywords. Score = weighted_score × log2(pages + 1)"""
    results = []
    for keyword, data in token_data.items():
        page_count = len(data['pages'])
        idf_factor = math.log2(page_count + 1)
        score = round(data['weighted_score'] * idf_factor, 2)

        # Per-source scores scaled by the same IDF factor
        source_scores = {
            source: round(raw * idf_factor, 2)
            for source, raw in data['source_scores'].items()
        }

        results.append({
            'keyword': keyword,
            'score': score,
            'frequency': data['frequency'],
            'pages': page_count,
            'sources': sorted(data['sources']),
            'source_scores': source_scores,
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return results[:limit]


def _extract_json_array(content):
    """Robustly extract a JSON array from AI response text."""
    content = content.strip()
    # Strip markdown code fences
    if content.startswith('```'):
        content = re.sub(r'^```(?:json)?\s*', '', content)
        content = re.sub(r'\s*```$', '', content)
        content = content.strip()

    # Try direct parse first
    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            for v in parsed.values():
                if isinstance(v, list):
                    return v
            return {'error': 'AI response was a JSON object with no array'}
        return {'error': 'AI response was not a JSON array'}
    except json.JSONDecodeError:
        pass

    # Try to find a JSON array in the text
    match = re.search(r'\[[\s\S]*\]', content)
    if match:
        try:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    return {'error': f'Could not extract JSON from AI response. Raw response: {content[:500]}'}


def analyze_keywords_with_ai(keywords, urls, provider, api_key, model=None, domain=None, links=None):
    """
    Enhance keyword analysis using an AI provider.

    Args:
        keywords: list of keyword dicts from extract_keywords()
        urls: list of crawled URL data dicts
        provider: 'openai', 'claude', or 'gemini'
        api_key: API key for the provider
        model: optional model override
        domain: domain name of the crawled site
        links: list of link data dicts from the crawl

    Returns:
        list of keyword dicts with added 'category' and 'relevance' fields
    """
    import requests as http_requests
    from urllib.parse import urlparse

    # Collect context signals (deduplicated, capped for token efficiency)
    titles = list(dict.fromkeys(
        u.get('title', '') for u in urls if u.get('title')
    ))[:50]
    h1s = list(dict.fromkeys(
        u.get('h1', '') for u in urls if u.get('h1')
    ))[:50]
    h2s = list(dict.fromkeys(
        h for u in urls for h in (u.get('h2') or []) if h
    ))[:30]
    h3s = list(dict.fromkeys(
        h for u in urls for h in (u.get('h3') or []) if h
    ))[:20]
    meta_descs = list(dict.fromkeys(
        u.get('meta_description', '') for u in urls if u.get('meta_description')
    ))[:50]
    url_paths = list(dict.fromkeys(
        urlparse(u.get('url', '')).path for u in urls if u.get('url')
    ))[:50]
    alt_texts = list(dict.fromkeys(
        img.get('alt', '') for u in urls for img in (u.get('images') or []) if img.get('alt')
    ))[:30]
    meta_keywords = list(dict.fromkeys(
        u.get('keywords', '') for u in urls if u.get('keywords')
    ))[:20]
    schema_types = list(dict.fromkeys(
        item.get('@type', '') for u in urls for item in (u.get('json_ld') or [])
        if isinstance(item, dict) and item.get('@type')
    ))[:20]
    anchor_texts = []
    if links:
        anchor_texts = list(dict.fromkeys(
            l.get('anchor_text', '') for l in links
            if l.get('anchor_text') and len(l['anchor_text']) > 1 and not l['anchor_text'].startswith('http')
        ))[:30]
    top_keywords = [k['keyword'] for k in keywords[:50]]

    prompt = (
        "You are an SEO analyst. Analyze this website's crawl data to identify the top 30 keywords "
        "this domain is targeting.\n\n"
        f"Domain: {domain or 'unknown'}\n\n"
        f"Page titles (sample): {titles}\n"
        f"H1 headings (sample): {h1s}\n"
        f"H2 headings (sample): {h2s}\n"
        f"H3 headings (sample): {h3s}\n"
        f"Meta descriptions (sample): {meta_descs}\n"
        f"URL paths (sample): {url_paths}\n"
        f"Image alt texts (sample): {alt_texts}\n"
        f"Anchor texts (sample): {anchor_texts}\n"
        f"Meta keywords (sample): {meta_keywords}\n"
        f"Schema types found: {schema_types}\n"
        f"Algorithmic top keywords: {top_keywords}\n\n"
        "For each keyword return a JSON object with:\n"
        '- "keyword": the keyword or phrase\n'
        '- "score": relevance score 0-100\n'
        '- "category": topic category (e.g. "Product", "Brand", "Technical", "Industry")\n'
        '- "relevance": brief explanation of why this keyword matters for this domain\n\n'
        "Return ONLY a JSON array, no other text."
    )

    try:
        if provider == 'openai':
            model = model or 'gpt-4o-mini'
            resp = http_requests.post(
                'https://api.openai.com/v1/chat/completions',
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json={
                    'model': model,
                    'messages': [{'role': 'user', 'content': prompt}],
                    'temperature': 0.3,
                    'response_format': {'type': 'json_object'}
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']

        elif provider == 'claude':
            model = model or 'claude-sonnet-4-6'
            resp = http_requests.post(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key': api_key,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                },
                json={
                    'model': model,
                    'max_tokens': 4096,
                    'messages': [{'role': 'user', 'content': prompt}],
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['content'][0]['text']

        elif provider == 'gemini':
            model = model or 'gemini-2.0-flash'
            resp = http_requests.post(
                f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}',
                headers={'Content-Type': 'application/json'},
                json={
                    'contents': [{'parts': [{'text': prompt}]}],
                    'generationConfig': {'temperature': 0.3}
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['candidates'][0]['content']['parts'][0]['text']

        else:
            return {'error': f'Unknown provider: {provider}'}

        return _extract_json_array(content)

    except http_requests.exceptions.RequestException as e:
        return {'error': f'API request failed: {str(e)}'}
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        return {'error': f'Failed to parse AI response: {str(e)}'}
    except Exception as e:
        return {'error': f'AI analysis failed: {str(e)}'}


def analyze_page_keywords_with_ai(url_data, provider, api_key, model=None, domain=None, links=None):
    """
    AI keyword analysis for a single page.

    Args:
        url_data: dict of crawled URL data for one page
        provider: 'openai', 'claude', or 'gemini'
        api_key: API key for the provider
        model: optional model override
        domain: domain name of the crawled site
        links: list of link dicts pointing TO this page

    Returns:
        list of keyword dicts with keyword, score, category, relevance
    """
    import requests as http_requests

    page_url = url_data.get('url', '')
    title = url_data.get('title', '')
    h1 = url_data.get('h1', '')
    h2s = [h for h in (url_data.get('h2') or []) if h][:10]
    h3s = [h for h in (url_data.get('h3') or []) if h][:10]
    meta_desc = url_data.get('meta_description', '')
    meta_kw = url_data.get('keywords', '')
    alt_texts = [img.get('alt', '') for img in (url_data.get('images') or []) if img.get('alt')][:15]
    schema_types = [
        item.get('@type', '') for item in (url_data.get('json_ld') or [])
        if isinstance(item, dict) and item.get('@type')
    ][:10]
    anchor_texts = []
    if links:
        anchor_texts = list(dict.fromkeys(
            l.get('anchor_text', '') for l in links
            if l.get('anchor_text') and len(l['anchor_text']) > 1 and not l['anchor_text'].startswith('http')
        ))[:15]

    prompt = (
        "You are an SEO analyst. Analyze this single page's content to identify the top 10 keywords "
        "this page is targeting.\n\n"
        f"Domain: {domain or 'unknown'}\n"
        f"Page URL: {page_url}\n"
        f"Title: {title}\n"
        f"H1: {h1}\n"
        f"H2 headings: {h2s}\n"
        f"H3 headings: {h3s}\n"
        f"Meta description: {meta_desc}\n"
        f"Meta keywords: {meta_kw}\n"
        f"Image alt texts: {alt_texts}\n"
        f"Anchor texts linking to this page: {anchor_texts}\n"
        f"Schema types: {schema_types}\n\n"
        "For each keyword return a JSON object with:\n"
        '- "keyword": the keyword or phrase\n'
        '- "score": relevance score 0-100\n'
        '- "category": topic category (e.g. "Product", "Brand", "Technical", "Industry")\n'
        '- "relevance": brief explanation of why this keyword matters for this page\n\n'
        "Return ONLY a JSON array, no other text."
    )

    try:
        if provider == 'openai':
            model = model or 'gpt-4o-mini'
            resp = http_requests.post(
                'https://api.openai.com/v1/chat/completions',
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json={
                    'model': model,
                    'messages': [{'role': 'user', 'content': prompt}],
                    'temperature': 0.3,
                    'response_format': {'type': 'json_object'}
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']

        elif provider == 'claude':
            model = model or 'claude-sonnet-4-6'
            resp = http_requests.post(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key': api_key,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                },
                json={
                    'model': model,
                    'max_tokens': 4096,
                    'messages': [{'role': 'user', 'content': prompt}],
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['content'][0]['text']

        elif provider == 'gemini':
            model = model or 'gemini-2.0-flash'
            resp = http_requests.post(
                f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}',
                headers={'Content-Type': 'application/json'},
                json={
                    'contents': [{'parts': [{'text': prompt}]}],
                    'generationConfig': {'temperature': 0.3}
                },
                timeout=60
            )
            resp.raise_for_status()
            content = resp.json()['candidates'][0]['content']['parts'][0]['text']

        else:
            return {'error': f'Unknown provider: {provider}'}

        return _extract_json_array(content)

    except http_requests.exceptions.RequestException as e:
        return {'error': f'API request failed: {str(e)}'}
    except (KeyError, IndexError) as e:
        return {'error': f'Failed to parse AI response: {str(e)}'}
    except Exception as e:
        return {'error': f'AI analysis failed: {str(e)}'}
