"""Unit tests for GBP match scoring + phone normalisation.

Focus: the reliability fixes added after the House of Dance false-positive.
Each test covers a specific failure mode so regressions are caught early.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.gbp_extractor import (  # noqa: E402
    _classify_match_tier,
    _normalize_phone,
    _phone_subscriber,
    _phones_match,
    match_place_to_branch,
)


# ---------------------------------------------------------------------------
# Phone normalisation
# ---------------------------------------------------------------------------

def test_normalize_phone_strips_all_non_digits():
    assert _normalize_phone("+27 (72) 426-6555") == "27724266555"
    assert _normalize_phone("") == ""
    assert _normalize_phone(None) == ""


def test_phone_subscriber_strips_leading_zero():
    # SA domestic format
    assert _phone_subscriber("072 426 6555") == "724266555"


def test_phone_subscriber_strips_country_code_to_match_domestic():
    # SA international and domestic reduce to the same subscriber digits
    assert _phone_subscriber("+27 72 426 6555") == "724266555"
    assert _phone_subscriber("072 426 6555") == "724266555"


def test_phones_match_sa_formats_equal():
    # The primary bug: last-10-digits comparison failed for SA phones.
    assert _phones_match("+27 72 426 6555", "072 426 6555") is True


def test_phones_match_sa_raw_to_international():
    assert _phones_match("72 426 6555", "+27 72 426 6555") is True


def test_phones_match_us_formats_equal():
    assert _phones_match("+1 555-123-4567", "(555) 123-4567") is True


def test_phones_match_uk_formats_equal():
    assert _phones_match("+44 20 7946 0958", "020 7946 0958") is True


def test_phones_match_different_numbers_reject():
    assert _phones_match("+27 72 426 6555", "+27 11 111 2222") is False


def test_phones_match_empty_is_false():
    assert _phones_match("", "+27 72 426 6555") is False
    assert _phones_match(None, None) is False


def test_phones_match_too_short_is_false():
    # Partial digits shouldn't produce false positives.
    assert _phones_match("555", "555") is False


# ---------------------------------------------------------------------------
# Tier classification
# ---------------------------------------------------------------------------

def test_tier_high_on_website_match():
    assert _classify_match_tier(50, ["website match"]) == "high"


def test_tier_high_on_phone_match():
    assert _classify_match_tier(30, ["phone match"]) == "high"


def test_tier_high_when_both_website_and_phone():
    assert _classify_match_tier(80, ["website match", "phone match"]) == "high"


def test_tier_medium_on_street_only():
    assert _classify_match_tier(25, ["street match"]) == "medium"


def test_tier_medium_on_street_plus_weak_signals():
    assert _classify_match_tier(45, ["street match", "city match", "exact name match"]) == "medium"


def test_tier_low_on_city_plus_name_only():
    # This is the House of Dance failure case: partial name + city in a
    # dense market produced a false positive. Tier must be low.
    assert _classify_match_tier(30, ["city match", "partial name match"]) == "low"


def test_tier_low_when_only_name_signals():
    assert _classify_match_tier(15, ["name contains match"]) == "low"


def test_tier_low_on_empty_reasons():
    assert _classify_match_tier(0, []) == "low"


# ---------------------------------------------------------------------------
# End-to-end scoring — synthetic Places responses
# ---------------------------------------------------------------------------

def _place(**kwargs):
    """Build a minimal Places API v1 response shape."""
    base = {
        "id": kwargs.pop("id", "ChIJ_test_" + kwargs.get("name", "x")),
        "displayName": {"text": kwargs.pop("name", "Test Place")},
        "formattedAddress": kwargs.pop("address", ""),
        "websiteUri": kwargs.pop("website", ""),
        "internationalPhoneNumber": kwargs.pop("phone", ""),
        "rating": kwargs.pop("rating", None),
        "userRatingCount": kwargs.pop("review_count", None),
    }
    base.update(kwargs)
    return base


def _branch(name, phone="", city="", street=""):
    return {
        "name": name,
        "telephone": phone,
        "address": {"city": city, "street": street},
    }


def test_match_website_domain_beats_partial_name():
    """Website match must outrank weak name-only hits even when name is worse."""
    places = [
        _place(name="Dance Equation", address="Irene, Centurion",
               website="http://www.danceequation.co.za/"),
        _place(name="House of Dance LABDS", address="VanX Studios, Centurion",
               website="https://houseofdancelabds.co.za/"),
    ]
    branch = _branch("House of Dance LABDS", city="centurion")
    ranked = match_place_to_branch(places, "houseofdancelabds.co.za", branch)
    assert ranked[0]["displayName"]["text"] == "House of Dance LABDS"
    assert ranked[0]["match_tier"] == "high"
    assert "website match" in ranked[0]["match_reasons"]


def test_match_sa_phone_scores_high():
    """The SA phone-format bug regression: domestic vs international phones match."""
    places = [
        _place(name="House of Dance LABDS",
               phone="+27 72 426 6555", address="Centurion"),
    ]
    branch = _branch("House of Dance LABDS", phone="072 426 6555", city="centurion")
    ranked = match_place_to_branch(places, "", branch)
    assert "phone match" in ranked[0]["match_reasons"]
    assert ranked[0]["match_tier"] == "high"


def test_match_no_structural_signal_is_low_tier():
    """The House of Dance false-positive regression: city+name only → low tier."""
    places = [
        _place(name="Dance Equation", address="Irene, Centurion, South Africa"),
    ]
    branch = _branch("House of Dance LABDS", city="centurion")
    ranked = match_place_to_branch(places, "houseofdancelabds.co.za", branch)
    # Some score may accrue from city + partial name but the tier must be low
    # because neither website, phone, nor street matched.
    assert ranked[0]["match_tier"] == "low"


def test_match_street_alone_is_medium():
    places = [
        _place(name="Some Other Studio",
               address="270 Witch Hazel Rd, Centurion, ZA"),
    ]
    branch = _branch("House of Dance LABDS",
                     city="centurion",
                     street="270 witch hazel road")
    ranked = match_place_to_branch(places, "", branch)
    # Street overlap scores +25 without a website/phone match → medium tier
    assert "street match" in ranked[0]["match_reasons"]
    assert ranked[0]["match_tier"] == "medium"


def test_match_ranked_by_confidence_descending():
    places = [
        _place(name="Weak Match", address="Centurion"),  # only city
        _place(name="Strong Match", address="Pretoria",
               phone="+27 11 111 2222",
               website="https://strong-match.co.za/"),
    ]
    branch = _branch("Strong Match", phone="011 111 2222", city="pretoria")
    ranked = match_place_to_branch(places, "strong-match.co.za", branch)
    assert ranked[0]["displayName"]["text"] == "Strong Match"
    assert ranked[0]["match_confidence"] > ranked[1]["match_confidence"]


if __name__ == "__main__":
    import subprocess
    sys.exit(subprocess.call([sys.executable, "-m", "pytest", __file__, "-v"]))
