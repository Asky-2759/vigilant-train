"""Short, result-grounded coaching; expressive delivery is separate from scoring."""
import re
from typing import Literal
from pydantic import BaseModel, Field


class CoachRequest(BaseModel):
    style: Literal['british', 'american', 'russian'] = 'british'
    playful: bool = True
    intent: Literal['feedback', 'simpler'] = 'feedback'
    take: int = Field(default=0, ge=0, le=10000)
    guidance: str = Field(default='', max_length=600)
    warning: str = Field(default='', max_length=300)
    focus: str = Field(default='', max_length=100)


def clean(value):
    # User phrases must not introduce voice direction tags or SSML.
    value = re.sub(r'/[^/\n]+/', 'the target sound', value)
    value = re.sub(r'[\u0250-\u02ff\u1d00-\u1d7f]', '', value)
    return re.sub(r'\s+', ' ', re.sub(r'[\[\]<>]', '', value)).strip()


def script(request):
    openers = {
        'british': ["Right then, mate — let's give this a go!", "All right! Tiny tongue workout. No gym membership required.", "Back for another go? That's the spirit!"],
        'american': ["Hey! Let's make this one a little easier.", "Okay, tiny tongue workout — zero push-ups required!", "Another round? I like your energy!"],
        'russian': ["All right, let's work on this together!", "A little tongue gymnastics. No medals needed!", "One more round. Small steps count!"],
    }
    opener = openers[request.style][request.take % 3] if request.playful else "Let's work on one thing together."
    focus = clean(request.focus)
    if request.warning:
        advice = 'First, let us get a clearer recording. ' + clean(request.warning)
    elif request.intent == 'simpler':
        advice = (f'Just one word for now: {focus}. ' if focus else '') + 'Listen once. Say it slowly. Then try the whole phrase. No rush.'
    elif request.guidance:
        advice = (f'Our focus is the word {focus}. ' if focus else '') + clean(request.guidance)
    elif focus:
        advice = f'Let us try {focus}. Listen to the example, say it slowly, then put it back into the sentence.'
    else:
        advice = 'Choose a phrase and give it a try. I will help you pick one thing to practise after your recording.'
    ending = 'Ready? Your turn.'
    transcript = f'{opener} {advice} {ending}'
    accent = '[strong Russian accent] ' if request.style == 'russian' else ''
    reaction = '[chuckles] ' if request.playful and request.take % 3 == 1 else ''
    spoken = f'{accent}[excited] {opener} {reaction} [warmly] {advice} ... [encouraging] {ending}'

    return transcript, spoken


def choose_voice(client, style):
    aliases = {'british': ('british', 'english'), 'american': ('american',), 'russian': ('russian',)}
    for voice in client.voices():
        accent = str(voice.get('labels', {}).get('accent', '')).lower()
        if any(label in accent for label in aliases[style]):
            return voice['id']
    return client.default_voice_id()
