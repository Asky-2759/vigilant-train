"""Exact IPA edit alignment. Differences are not validated pronunciation errors."""
from functools import lru_cache
import unicodedata

ACCENTS = {
    "US": "en-us", "British": "en", "Caribbean": "en-029",
    "Carribean": "en-029", "Lancastrian": "en-gb-x-gbclan",
    "RP": "en-gb-x-rp", "Scotland": "en-gb-scotland",
    "West Midlands": "en-gb-x-gbcwmd",
}


@lru_cache(maxsize=1)
def feature_table():
    import panphon
    return panphon.FeatureTable()

IPA_ALIASES = {
    "ɚ": "əɹ",
    "ɝ": "ɜɹ",
    "ᵻ": "ɪ",
}
def segment_ipa(value):
    """Apply the same segmentation to both streams; reject unknown symbols.

    Input must be IPA, not words, ARPABET, or model special tokens.
    Stress and whitespace are ignored; phonetic distinctions are retained.
    """
    if isinstance(value, list):
        if not all(isinstance(token, str) for token in value):
            raise TypeError("Phoneme tokens must be strings.")
        value = " ".join(value)
    if not isinstance(value, str):
        raise TypeError("Expected an IPA string or list of IPA strings.")
    value = unicodedata.normalize("NFD", value)
    for old, new in IPA_ALIASES.items():
        value = value.replace(old, new)
    clean = "".join(c for c in value if not c.isspace() and c not in "ˈˌ")
    segments = feature_table().ipa_segs(clean)
    if "".join(segments) != clean:
        raise ValueError(f"Unrecognized IPA symbols in {value!r}; check recognizer output.")
    return segments


def align_phones(actual, expected):
    """Return (kind, detected, expected) tuples in utterance order."""
    n, m = len(actual), len(expected)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                           dp[i - 1][j - 1] + (actual[i - 1] != expected[j - 1]))
    differences = []
    i, j = n, m
    while i or j:
        if i and j and actual[i - 1] == expected[j - 1] and dp[i][j] == dp[i - 1][j - 1]:
            i, j = i - 1, j - 1
        elif i and j and dp[i][j] == dp[i - 1][j - 1] + 1:
            differences.append(("Substitution", actual[i - 1], expected[j - 1]))
            i, j = i - 1, j - 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            differences.append(("Extra", actual[i - 1], "-"))
            i -= 1
        else:
            differences.append(("Missing", "-", expected[j - 1]))
            j -= 1
    return differences[::-1]


def compare_pronunciation(text: str, audio_phonemes: list[str], accent: str = "US"):
    from phonemizer import phonemize
    if not text.strip():
        raise ValueError("A target sentence is required.")
    if accent not in ACCENTS:
        raise ValueError(f"Unknown accent {accent!r}. Choose from {list(ACCENTS)}")
    actual = segment_ipa(audio_phonemes)
    if not actual:
        raise ValueError("Recognizer returned no phonemes; retry the recording.")
    expected = segment_ipa(phonemize(
        text, language=ACCENTS[accent], backend="espeak", strip=True,
        with_stress=False, preserve_punctuation=False,
        language_switch="remove-flags"))
    if not expected:
        raise ValueError("Could not generate expected phonemes.")
    return align_phones(actual, expected)
