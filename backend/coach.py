"""Short, result-grounded coaching; expressive delivery is separate from scoring."""
import re
from typing import Literal
from pydantic import BaseModel, Field


class CoachRequest(BaseModel):
    style: Literal['british', 'american', 'russian'] = 'british'
    playful: bool = True
    guidance: str = Field(default='', max_length=600)
    warning: str = Field(default='', max_length=300)
    focus: str = Field(default='', max_length=100)


def clean(value):
    # User phrases must not introduce voice direction tags or SSML.
    return re.sub(r'\s+', ' ', re.sub(r'[\[\]<>]', '', value)).strip()


def script(request):
    openers = {
        'british': "All right, mate! Tongue doing a little gymnastics? We've got this.",
        'american': "Hey, you've got this! A tongue twister is just a tiny workout without the gym fee.",
        'russian': "Ready for another round? Your tongue is warming up, not applying for the Olympics.",
    }
    opener = openers[request.style] if request.playful else "Let's take this one step at a time."
    if request.warning:
        advice = 'Before we judge the sounds, ' + clean(request.warning)
    elif request.guidance:
        advice = clean(request.guidance)
    elif request.focus:
        advice = f"Let's revisit {clean(request.focus)}. Listen to the reference, say it slowly, then put it back in the sentence."
    else:
        advice = 'Listen to the reference once, then record a phrase at your own pace.'
    ending = "One useful next step beats chasing a perfect score. You've got another take in you!"
    transcript = f'{opener} {advice} {ending}'
    accent = {'british': 'British', 'american': 'American', 'russian': 'Russian'}[request.style]
    spoken = f'[strong {accent} accent] [warmly] {opener} [encouraging] {advice} {ending}'
    return transcript, spoken


def choose_voice(client, style):
    aliases = {'british': ('british', 'english'), 'american': ('american',), 'russian': ('russian',)}
    for voice in client.voices():
        accent = str(voice.get('labels', {}).get('accent', '')).lower()
        if any(label in accent for label in aliases[style]):
            return voice['id']
    return client.default_voice_id()
