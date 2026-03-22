"""Google Business Profile extractor for LibreCrawl.

Extracts business contact info from crawled pages (JSON-LD, schema.org),
searches Google Places API (New) for matching profiles, and builds
a multi-branch GBP report.
"""

import re
import json
from datetime import datetime
from urllib.parse import urlparse

import requests as http_requests


# Schema.org types that represent business entities
BUSINESS_TYPES = {
    'LocalBusiness', 'Organization', 'Restaurant', 'Store', 'Hotel',
    'MedicalBusiness', 'LegalService', 'FinancialService', 'RealEstateAgent',
    'AutomotiveBusiness', 'EducationalOrganization', 'GovernmentOrganization',
    'SportsActivityLocation', 'EntertainmentBusiness', 'FoodEstablishment',
    'HealthAndBeautyBusiness', 'HomeAndConstructionBusiness',
    'InternetCafe', 'LodgingBusiness', 'ProfessionalService',
    'ShoppingCenter', 'SportsClub', 'TouristInformationCenter',
    'AnimalShelter', 'ChildCare', 'DryCleaningOrLaundry',
    'EmergencyService', 'EmploymentAgency', 'Library',
    'RadioStation', 'RecyclingCenter', 'TravelAgency',
    'Dentist', 'Physician', 'Pharmacy', 'Optician', 'VeterinaryCare',
    'BarOrPub', 'CafeOrCoffeeShop', 'FastFoodRestaurant', 'IceCreamShop',
    'AutoBodyShop', 'AutoDealer', 'AutoPartsStore', 'AutoRental', 'AutoRepair',
    'AutoWash', 'GasStation', 'MotorcycleDealer', 'MotorcycleRepair',
    'Bakery', 'Brewery', 'Distillery', 'Winery',
    'Corporation', 'NGO', 'Consortium',
    'AccountingService', 'AttorneyLegal', 'Notary',
    'InsuranceAgency', 'MovingCompany', 'PlumbingService', 'ElectricalService',
    'HVACBusiness', 'RoofingContractor', 'GeneralContractor',
}

# Google Places API field mask for Text Search
PLACES_FIELD_MASK = ','.join([
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.googleMapsUri',
    'places.rating',
    'places.userRatingCount',
    'places.currentOpeningHours',
    'places.regularOpeningHours',
    'places.photos',
    'places.types',
    'places.businessStatus',
    'places.reviews',
    'places.priceLevel',
    'places.editorialSummary',
    'places.location',
    'places.shortFormattedAddress',
])

# Field mask for Place Details (single place)
DETAIL_FIELD_MASK = ','.join([
    'id',
    'displayName',
    'formattedAddress',
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'websiteUri',
    'googleMapsUri',
    'rating',
    'userRatingCount',
    'currentOpeningHours',
    'regularOpeningHours',
    'photos',
    'types',
    'businessStatus',
    'reviews',
    'priceLevel',
    'editorialSummary',
    'location',
    'shortFormattedAddress',
])

# Phone regex: matches common phone formats
PHONE_REGEX = re.compile(
    r'(?:\+?\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}'
)


def extract_business_info(urls):
    """Extract business entities from crawled URL data.

    Scans JSON-LD (including @graph arrays and nested entities) and
    schema.org structured data for business types.
    Deduplicates by address (franchises share a name but have different addresses).

    Returns:
        dict with keys: branches (list), brand_name (str), fallback_query (str)
    """
    branches = []
    seen_addresses = set()
    name_counts = {}

    for url_data in urls:
        source_page = url_data.get('url', '')

        # Scan JSON-LD — handle top-level objects, @graph arrays, and nested entities
        for ld in (url_data.get('json_ld') or []):
            if not isinstance(ld, dict):
                continue
            _walk_json_ld(ld, source_page, branches, seen_addresses, name_counts)

        # Scan schema.org microdata
        for schema in (url_data.get('schema_org') or []):
            if not isinstance(schema, dict):
                continue
            _walk_json_ld(schema, source_page, branches, seen_addresses, name_counts)

    # Determine brand name (most frequent business name)
    brand_name = ''
    if name_counts:
        brand_name = max(name_counts, key=name_counts.get)

    # Fallback query if no structured data found
    fallback_query = brand_name
    if not fallback_query:
        fallback_query = _get_fallback_query(urls)

    # If no branches from structured data, create a single fallback branch
    if not branches:
        fallback_phone = _extract_phone_fallback(urls)
        branches.append({
            'name': fallback_query,
            'telephone': fallback_phone,
            'email': '',
            'address': {},
            'url': '',
            'source_page': urls[0].get('url', '') if urls else '',
            'from_structured_data': False,
        })

    return {
        'branches': branches,
        'brand_name': brand_name,
        'fallback_query': fallback_query,
    }


def _walk_json_ld(data, source_page, branches, seen_addresses, name_counts):
    """Recursively walk JSON-LD data to find all business entities.

    Handles:
    - Top-level business entities
    - @graph arrays containing multiple entities
    - Nested 'location', 'department', 'subOrganization' properties
    """
    if not isinstance(data, dict):
        return

    # Handle @graph: iterate over all items in the graph
    if '@graph' in data:
        graph = data['@graph']
        if isinstance(graph, list):
            for item in graph:
                if isinstance(item, dict):
                    _walk_json_ld(item, source_page, branches, seen_addresses, name_counts)
        return

    # Try to extract this entity itself
    _extract_entity(data, source_page, branches, seen_addresses, name_counts)

    # Check nested properties that may contain sub-businesses
    for nested_key in ('location', 'department', 'subOrganization', 'branchOf',
                       'containsPlace', 'hasOfferCatalog'):
        nested = data.get(nested_key)
        if isinstance(nested, dict):
            _walk_json_ld(nested, source_page, branches, seen_addresses, name_counts)
        elif isinstance(nested, list):
            for item in nested:
                if isinstance(item, dict):
                    _walk_json_ld(item, source_page, branches, seen_addresses, name_counts)


def _extract_entity(data, source_page, branches, seen_addresses, name_counts):
    """Extract a single business entity from a JSON-LD or schema.org dict."""
    entity_type = data.get('@type', '') or data.get('type', '')
    if isinstance(entity_type, list):
        # Use the first type, or check all types
        matched = False
        for t in entity_type:
            type_name = t.rsplit('/', 1)[-1] if '/' in t else t
            if type_name in BUSINESS_TYPES:
                matched = True
                break
        if not matched:
            return
    else:
        type_name = entity_type.rsplit('/', 1)[-1] if '/' in entity_type else entity_type
        if type_name not in BUSINESS_TYPES:
            return

    name = (data.get('name') or '').strip()
    if not name:
        return

    # Track name frequency
    name_counts[name] = name_counts.get(name, 0) + 1

    # Extract address — handle PostalAddress object, string, or nested
    address = _extract_address(data.get('address'))

    # Deduplicate by address (street + city + postal)
    addr_key = f"{address.get('street', '')}|{address.get('city', '')}|{address.get('postal', '')}".lower().strip('|')
    if addr_key and addr_key in seen_addresses:
        return
    if addr_key:
        seen_addresses.add(addr_key)

    telephone = (data.get('telephone') or '').strip()
    email = (data.get('email') or '').strip()
    url = (data.get('url') or '').strip()

    branches.append({
        'name': name,
        'telephone': telephone,
        'email': email,
        'address': address,
        'url': url,
        'source_page': source_page,
        'from_structured_data': True,
    })


def _extract_address(addr_data):
    """Extract a structured address from various JSON-LD address formats."""
    if not addr_data:
        return {}

    if isinstance(addr_data, str):
        # Try to parse "123 Main St, City, State 12345" style
        return {'street': addr_data.strip(), 'city': '', 'region': '', 'postal': '', 'country': ''}

    if isinstance(addr_data, list):
        # Take first address
        addr_data = addr_data[0] if addr_data else {}

    if isinstance(addr_data, dict):
        return {
            'street': (addr_data.get('streetAddress') or '').strip(),
            'city': (addr_data.get('addressLocality') or '').strip(),
            'region': (addr_data.get('addressRegion') or '').strip(),
            'postal': (addr_data.get('postalCode') or '').strip(),
            'country': (addr_data.get('addressCountry') or '').strip(),
        }

    return {}


def _get_fallback_query(urls):
    """Get a fallback search query from OG tags or page title."""
    for url_data in urls:
        og = url_data.get('og_tags') or {}
        if og.get('site_name'):
            return og['site_name']

    # Use homepage title
    if urls:
        title = urls[0].get('title', '')
        if title:
            # Strip common suffixes like " | Home", " - Official Site"
            title = re.split(r'\s*[\|\-–—]\s*', title)[0].strip()
            return title

    return ''


def _extract_phone_fallback(urls):
    """Extract phone number from meta descriptions and titles as fallback."""
    for url_data in urls:
        for field in ['meta_description', 'title']:
            text = url_data.get(field, '') or ''
            match = PHONE_REGEX.search(text)
            if match:
                return match.group().strip()
    return ''


def search_google_places(query, api_key, location_bias=None):
    """Search Google Places API (New) via Text Search.

    Args:
        query: Text search query (e.g. "Acme Corp Chicago")
        api_key: Google Places API key
        location_bias: Optional dict with 'lat', 'lng', 'radius' for location bias

    Returns:
        dict with 'places' list or 'error' string
    """
    url = 'https://places.googleapis.com/v1/places:searchText'
    headers = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': api_key,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
    }
    body = {
        'textQuery': query,
        'maxResultCount': 10,
    }
    if location_bias:
        body['locationBias'] = {
            'circle': {
                'center': {
                    'latitude': location_bias['lat'],
                    'longitude': location_bias['lng'],
                },
                'radius': location_bias.get('radius', 5000.0),
            }
        }

    try:
        print(f"[GBP] Searching Places API: {query}")
        resp = http_requests.post(url, headers=headers, json=body, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            places = data.get('places', [])
            print(f"[GBP] Found {len(places)} places for query: {query}")
            return data
        print(f"[GBP] Places API error ({resp.status_code}): {resp.text[:200]}")
        return {'error': f'Google Places API error ({resp.status_code}): {resp.text[:500]}'}
    except http_requests.RequestException as e:
        return {'error': f'Network error calling Google Places API: {str(e)}'}


def get_place_details(place_id, api_key):
    """Fetch full details for a single place."""
    if not place_id.startswith('places/'):
        place_id = f'places/{place_id}'

    url = f'https://places.googleapis.com/v1/{place_id}'
    headers = {
        'X-Goog-Api-Key': api_key,
        'X-Goog-FieldMask': DETAIL_FIELD_MASK,
    }

    try:
        resp = http_requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            return resp.json()
        return {'error': f'Google Places API error ({resp.status_code}): {resp.text[:500]}'}
    except http_requests.RequestException as e:
        return {'error': f'Network error: {str(e)}'}


def get_photo_uri(photo_name, api_key, max_width=400):
    """Build a Google Places photo media URL."""
    return f'https://places.googleapis.com/v1/{photo_name}/media?maxWidthPx={max_width}&key={api_key}'


def match_place_to_branch(places, domain, branch):
    """Score and rank Google Places results against an extracted branch.

    Scoring system:
        +50 if websiteUri domain matches crawled domain
        +30 if phone number matches (digits only)
        +25 if street address has significant overlap
        +20 if city/locality matches
        +15 if business name is contained in place name (or vice versa)
        +10 if business name exact-matches

    Returns:
        list of places sorted by match_confidence (descending), best match first
    """
    scored = []
    branch_name = (branch.get('name') or '').lower().strip()
    branch_phone = _normalize_phone(branch.get('telephone', ''))
    branch_city = (branch.get('address', {}).get('city') or '').lower().strip()
    branch_street = (branch.get('address', {}).get('street') or '').lower().strip()

    for place in places:
        score = 0
        match_reasons = []

        # Website domain match (+50)
        place_website = place.get('websiteUri', '')
        if place_website and domain:
            place_domain = urlparse(place_website).netloc.lower().replace('www.', '')
            crawl_domain = domain.lower().replace('www.', '')
            if place_domain == crawl_domain:
                score += 50
                match_reasons.append('website match')

        # Phone match (+30)
        place_phone = _normalize_phone(
            place.get('nationalPhoneNumber', '') or place.get('internationalPhoneNumber', '')
        )
        if place_phone and branch_phone:
            # Compare last 10 digits to handle country code variations
            if place_phone[-10:] == branch_phone[-10:] and len(branch_phone) >= 7:
                score += 30
                match_reasons.append('phone match')

        # Street address match (+25)
        place_address = (place.get('formattedAddress') or '').lower()
        if branch_street and len(branch_street) > 5:
            # Check if significant parts of the street overlap
            street_words = set(branch_street.split()) - {'st', 'rd', 'ave', 'dr', 'ln', 'street', 'road', 'avenue', 'drive'}
            if street_words:
                matches = sum(1 for w in street_words if w in place_address)
                if matches >= len(street_words) * 0.6:
                    score += 25
                    match_reasons.append('street match')

        # City match (+20)
        if branch_city and len(branch_city) > 2 and branch_city in place_address:
            score += 20
            match_reasons.append('city match')

        # Name matching — fuzzy
        place_name = (place.get('displayName', {}).get('text', '') or '').lower().strip()
        if branch_name and place_name:
            if branch_name == place_name:
                score += 10
                match_reasons.append('exact name match')
            elif branch_name in place_name or place_name in branch_name:
                score += 15
                match_reasons.append('name contains match')
            else:
                # Check word overlap
                branch_words = set(branch_name.split()) - {'the', 'and', 'of', 'a', 'an'}
                place_words = set(place_name.split()) - {'the', 'and', 'of', 'a', 'an'}
                if branch_words and place_words:
                    overlap = branch_words & place_words
                    if len(overlap) >= min(len(branch_words), len(place_words)) * 0.5:
                        score += 10
                        match_reasons.append('partial name match')

        place_copy = dict(place)
        place_copy['match_confidence'] = score
        place_copy['match_reasons'] = match_reasons
        scored.append(place_copy)

    scored.sort(key=lambda p: p['match_confidence'], reverse=True)
    return scored


def _normalize_phone(phone):
    """Strip non-digit chars for comparison."""
    return re.sub(r'\D', '', phone or '')


def build_gbp_report(urls, api_key):
    """Build a complete GBP report for a crawled site.

    Extracts business info from crawl data, searches Google Places for each
    branch, and matches results. Uses multiple search strategies to find the
    best match.

    Args:
        urls: List of crawled URL data dicts
        api_key: Google Places API key

    Returns:
        dict with domain, brand_name, branches (each with extracted, gbp, candidates)
    """
    if not urls:
        return {
            'domain': '',
            'brand_name': '',
            'branches': [],
            'analyzed_at': datetime.now().isoformat(),
        }

    # Determine domain
    first_url = urls[0].get('url', '')
    domain = urlparse(first_url).netloc if first_url else ''

    # Extract business info
    info = extract_business_info(urls)
    print(f"[GBP] Extracted {len(info['branches'])} branches, brand: {info.get('brand_name', '?')}")
    for b in info['branches']:
        addr = b.get('address', {})
        print(f"[GBP]   Branch: {b.get('name')} | city={addr.get('city', '?')} | phone={b.get('telephone', '?')} | structured={b.get('from_structured_data')}")

    branches_result = []

    for branch in info['branches']:
        branch_result = {
            'extracted': branch,
            'gbp': None,
            'match_confidence': 0,
            'search_query': '',
            'all_candidates': [],
        }

        # Build search queries — try multiple strategies
        name = branch.get('name') or info.get('fallback_query') or domain
        city = branch.get('address', {}).get('city', '')
        street = branch.get('address', {}).get('street', '')
        region = branch.get('address', {}).get('region', '')

        # Strategy 1: Name + City (most common and effective)
        queries = []
        if city:
            queries.append(f'{name} {city}')
        # Strategy 2: Name + Region (if no city)
        if region and not city:
            queries.append(f'{name} {region}')
        # Strategy 3: Name + Street (if we have an address)
        if street and city:
            queries.append(f'{name} {street} {city}')
        # Strategy 4: Just name (fallback)
        if not queries:
            queries.append(name)

        best_result = None
        best_score = -1

        for query in queries:
            branch_result['search_query'] = query

            search_result = search_google_places(query, api_key)
            if 'error' in search_result:
                branch_result['error'] = search_result['error']
                continue

            places = search_result.get('places', [])
            if not places:
                continue

            # Match and rank
            ranked = match_place_to_branch(places, domain, branch)

            if ranked and ranked[0].get('match_confidence', 0) > best_score:
                best_score = ranked[0]['match_confidence']
                best_result = ranked
                branch_result['search_query'] = query
                branch_result['error'] = None  # Clear any previous error

            # If we got a strong match (domain + something else), stop trying
            if best_score >= 65:
                break

        if best_result:
            branch_result['all_candidates'] = best_result
            branch_result['gbp'] = best_result[0]
            branch_result['match_confidence'] = best_result[0].get('match_confidence', 0)
            print(f"[GBP]   Best match for '{name}' ({city}): {best_result[0].get('displayName', {}).get('text', '?')} "
                  f"score={best_score} reasons={best_result[0].get('match_reasons', [])}")
        else:
            print(f"[GBP]   No match found for '{name}' ({city})")

        branches_result.append(branch_result)

    # Post-processing: if we have a single branch with multiple high-confidence
    # candidates (e.g. same business, multiple locations), promote each candidate
    # to its own branch so they all get displayed.
    final_branches = []
    for branch_result in branches_result:
        candidates = branch_result.get('all_candidates', [])
        # Find all candidates that match on website domain (strong signal for same business)
        domain_matches = [c for c in candidates if 'website match' in c.get('match_reasons', [])]

        if len(domain_matches) > 1:
            # Multiple locations for the same business — promote each to a branch
            for candidate in domain_matches:
                new_branch = {
                    'extracted': dict(branch_result['extracted']),
                    'gbp': candidate,
                    'match_confidence': candidate.get('match_confidence', 0),
                    'search_query': branch_result.get('search_query', ''),
                    'all_candidates': [candidate],
                }
                # Enrich extracted info with GBP data for this location
                gbp_name = candidate.get('displayName', {}).get('text', '')
                gbp_addr = candidate.get('formattedAddress', '')
                gbp_phone = candidate.get('nationalPhoneNumber', '') or candidate.get('internationalPhoneNumber', '')
                new_branch['extracted'] = dict(new_branch['extracted'])
                new_branch['extracted']['gbp_name'] = gbp_name
                new_branch['extracted']['gbp_address'] = gbp_addr
                new_branch['extracted']['gbp_phone'] = gbp_phone
                final_branches.append(new_branch)
                print(f"[GBP]   Promoted candidate to branch: {gbp_name} @ {candidate.get('shortFormattedAddress', '')}")
        else:
            final_branches.append(branch_result)

    return {
        'domain': domain,
        'brand_name': info.get('brand_name', ''),
        'branches': final_branches,
        'analyzed_at': datetime.now().isoformat(),
    }
