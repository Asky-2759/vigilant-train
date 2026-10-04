import json

from google import genai

client = genai.Client(api_key="YOUR_API_KEY")


def prepare_pronunciation_payload(entries: list[tuple[str, str, str]]) -> str:
    # Prepare a pronunciation-feedback prompt from (word, phonemes, target IPA) entries.
    pronunciation_data = [
        {"word": word, "phoneme_transcription": phonemes, "target_ipa": ipa}
        for word, phonemes, ipa in entries
    ]
    return (
        "Give concise, supportive pronunciation feedback for each entry. "
        "Compare the phoneme transcription of the learner's pronunciation with "
        "the target IPA, and identify only differences supported by the data. "
        "For each entry, explain the likely sound to work on and give a practical "
        "articulation tip (such as lip or tongue placement) when relevant. "
        "Do not claim to have heard audio or observed the learner's mouth. "
        "If the transcription does not reveal a clear issue, say so rather than "
        "inventing one. Keep the feedback understandable to a language learner."
        "Acknowledge any possible consonant drifts or vowel shifts that may be the result "
        "of the speaker's accent but evaluate them fairly and if it affects the clarity of "
        "the speech.\n\n"
        "Pronunciation entries (JSON):\n"
        f"{json.dumps(pronunciation_data, ensure_ascii=False)}"
    )


# Each entry contains the word, its phoneme transcription, and the target IPA.
entries = []

interaction = client.interactions.create(
    model="gemini-3.8-flash",
    input=prepare_pronunciation_payload(entries),
)

print(interaction.output_text)

# Example: 
# (hello, hɛˈloʊ, həˈloʊ)
# (world, wɜːrld, wɝld) 