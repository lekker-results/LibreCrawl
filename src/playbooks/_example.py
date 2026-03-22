"""
Example directory playbook template.

To create a new playbook:
1. Run: playwright codegen https://example-directory.co.za
2. Record the search flow and registration flow
3. Copy the generated code into verify() and register() below
4. Replace hardcoded values with function parameters
5. Save as src/playbooks/your_directory_name.py (no underscore prefix)
"""

METADATA = {
    "name": "Example Directory",           # Human-readable name
    "domain": "example-directory.co.za",   # Domain for reference
    "tier": 2,                             # 1=essential, 2=standard, 3=review, 4=niche
    "has_captcha": False,                  # Does the registration form have a CAPTCHA?
    "requires_email_verification": False,  # Does registration require email verification?
    "category": "general",                 # general, children, healthcare, legal, etc.
    "last_tested": "2026-03-17",           # When this playbook was last verified working
}


async def verify(page, business_name, location):
    """
    Search for a business on this directory.

    Args:
        page: Playwright Page object
        business_name: e.g. "Smile Care Dentistry"
        location: e.g. "Centurion, Pretoria"

    Returns:
        List of dicts, each with keys: name, phone, address, url
        Return empty list if no results found.
    """
    # --- PASTE YOUR CODEGEN SEARCH FLOW HERE ---
    # Replace hardcoded search terms with business_name and location

    await page.goto(f'https://example-directory.co.za/search?q={business_name}&loc={location}')
    await page.wait_for_selector('.results', timeout=10000)

    results = await page.query_selector_all('.result-item')
    matches = []
    for result in results:
        name_el = await result.query_selector('.result-name')
        phone_el = await result.query_selector('.result-phone')
        addr_el = await result.query_selector('.result-address')
        link_el = await result.query_selector('a')

        matches.append({
            'name': await name_el.inner_text() if name_el else '',
            'phone': await phone_el.inner_text() if phone_el else '',
            'address': await addr_el.inner_text() if addr_el else '',
            'url': await link_el.get_attribute('href') if link_el else '',
        })

    return matches


async def register(page, nap):
    """
    Navigate to registration page and fill in the form.
    Do NOT click submit — the session handler does that.

    Args:
        page: Playwright Page object
        nap: dict with keys: name, address, phone, website, email, category, description
    """
    # --- PASTE YOUR CODEGEN REGISTRATION FLOW HERE ---
    # Replace hardcoded values with nap['name'], nap['phone'], etc.

    await page.goto('https://example-directory.co.za/add-listing')
    await page.fill('#business_name', nap.get('name', ''))
    await page.fill('#phone', nap.get('phone', ''))
    await page.fill('#address', nap.get('address', ''))
    await page.fill('#website', nap.get('website', ''))
    await page.fill('#email', nap.get('email', ''))
    # DO NOT click submit here


async def submit(page):
    """
    Optional: custom submit logic if the default submit detection doesn't work.
    Only needed for directories with non-standard submit buttons.
    """
    await page.click('button[type="submit"]')
