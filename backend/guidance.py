"""Conservative practice priorities from existing recognizer evidence.

Confidence here is the recognizer's internal heuristic, not a calibrated
probability that a person mispronounced something.
"""


def practice_guidance(words, quality, word_error_rate=0):
    if quality['warnings']:
        return {'title': 'Start with a clearer recording',
                'message': quality['warnings'][0], 'position': None}
    if word_error_rate >= .6:
        return {'title': 'Check the phrase before drilling sounds',
                'message': 'The recognized words differ substantially from the practice phrase. Check the transcript and recording, then read the displayed phrase again. Recognition can also be wrong.',
                'position': None}
    flagged = [word for word in words if word['status'] != 'ok']
    if not flagged:
        return {'title': 'Try the phrase in a new context',
                'message': 'No sound differences were flagged. Listen back, then try a longer sentence using one of these words.',
                'position': None}
    word = max(flagged, key=lambda item: item.get('confidence', 0))
    tentative = word.get('confidence', 0) < .65
    return {
        'title': f"Listen again to “{word['word']}”",
        'message': ('The model is uncertain about this word. Compare the recordings before changing how you say it.'
                    if tentative else
                    'This word has a stronger model flag. Listen to the reference slowly, repeat the word, then return to the sentence.'),
        'position': word['position'],
    }
