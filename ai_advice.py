import json

DEFAULT_MODEL = "gemini-3.8-flash"


def prepare_pronunciation_payload(entries: list[tuple[str, str, str]]) -> str:
    # uild a prompt from (word, heard IPA, target IPA) entries.
    pronunciation_data = [
        {"word": word, "phoneme_transcription": heard, "target_ipa": ipa}
        for word, heard, ipa in entries
    ]

    if not pronunciation_data:
        raise ValueError("Perfect! There is nothing to improve.")

    return (
        "Give concise, supportive pronunciation feedback for each entry. "
        "Compare the learner's phoneme transcription with the target IPA, and "
        "identify only differences supported by the data. For each entry, explain "
        "the likely sound to work on and give a practical articulation tip when "
        "relevant. Do not claim to have heard audio or observed the learner's "
        "mouth. If the transcription does not reveal a clear issue, say so rather "
        "than inventing one. Keep the feedback understandable to a language "
        "learner. Acknowledge possible consonant drifts or vowel shifts that may "
        "result from the speaker's accent, evaluating them fairly and noting "
        "whether they affect clarity.\n\n"
        "Pronunciation entries (JSON):\n"
        f"{json.dumps(pronunciation_data, ensure_ascii=False)}"
    )


def generate_pronunciation_feedback(
    entries: list[tuple[str, str, str]],
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
) -> str:
    # Generate learner-facing feedback using the configured Gemini model.
    if not entries:
        raise ValueError("at least one pronunciation entry is required")
    if not api_key:
        raise ValueError("a Gemini API key is required")

    from google import genai

    with genai.Client(api_key=api_key) as client:
        response = client.models.generate_content(
            model=model,
            contents=prepare_pronunciation_payload(entries),
        )
    feedback = response.text
    if not feedback or not feedback.strip():
        raise RuntimeError("Gemini returned empty pronunciation feedback")
    return feedback.strip()
