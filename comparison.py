from phonemizer import phonemize
from speech_to_ipa import parse_audio
import panphon

ipa_table = panphon.FeatureTable()
accents = {"US": "en-us",
           "British": "en", 
           "Carribean": "en-029", 
           "Lancastrian": "en-gb-x-gbclan",
           "RP": "en-gb-x-rp",
           "Scotland": "en-gb-scotland",
           "West Midlands":"en-gb-x-gbcwmd"}


def compare_pronunciation(text: str, audio_phonemes: list[str], accent: str):
    
    expected_pronunciation = phonemize(text, language=accents.get(accent, "en"), backend="espeak")
    expected_ipa = ipa_table.segs(expected_pronunciation)
    
    n, m = len(audio_phonemes), len(expected_ipa)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
        
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if audio_ipa[i-1] == expected_ipa[j-1] else 1
            dp[i][j] = min(
                dp[i-1][j] + 1,     # Deletion 
                dp[i][j-1] + 1,     # Insertion
                dp[i-1][j-1] + cost # Match or Substitution
            )
            
    i, j = n, m
    differences = []
    
    while i > 0 or j > 0:
        current_cost = dp[i][j]
        
        if i > 0 and j > 0 and audio_ipa[i-1] == expected_ipa[j-1] and current_cost == dp[i-1][j-1]:
            i -= 1
            j -= 1
        elif i > 0 and j > 0 and current_cost == dp[i-1][j-1] + 1:
            differences.append(("Substitution", audio_ipa[i-1], expected_ipa[j-1]))
            i -= 1
            j -= 1
        elif i > 0 and current_cost == dp[i-1][j] + 1:
            differences.append(("Extra", audio_ipa[i-1], "-"))
            i -= 1
        else:
            differences.append(("Missing", "-", expected_ipa[j-1]))
            j -= 1
            
    differences.reverse()
    return differences
        
    