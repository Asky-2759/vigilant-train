from phonemizer import phonemize
from speech_to_ipa import parse_audio

accents = {"US": "en-us",
           "British": "en", 
           "Carribrean": "en-029", 
           "Lancastrian": "en-gb-x-gbclan",
           "RP": "en-gb-x-rp",
           "Scotland": "en-gb-scotland",
           "West Midlands":"en-gb-x-gbcwmd"}

def compare_pronunciation(text: str, audio_file: str, accent: str):
    audio_ipa = parse_audio(audio_file).split()
    
    expected_pronunciation = phonemize(text, language=accents[accent], backend="espeak")
    
    differences = []
    for phoneme, exp_phoneme in zip(audio_ipa, list(expected_pronunciation)):
        if not phoneme == exp_phoneme:
            differences.append((phoneme, exp_phoneme))
    return differences
        
    