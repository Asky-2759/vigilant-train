# What Speech Clarity measures

This is practice feedback, not a calibrated proficiency or accent grade.

## Combined estimate

The inherited OpenPronounce weights are 40% sounds, 30% recognized words and
30% acoustic reference similarity. Each dimension is clipped to 0–100.
When reference synthesis fails, sounds and words are renormalized to roughly
57% and 43%. The interface shows the actual weights for each result. Do not
compare a reference-free take with a take that includes acoustic comparison.

- **Sounds:** 100 × (1 − weighted phone edit rate). OpenPronounce 0.3.0's
  accepted pronunciation candidates and near-phone costs are used to avoid
  penalizing a variant that its own word-level feedback accepts. Completely
  missing words receive full deletion cost. The strict upstream rate is retained
  as `differences.phoneme_error_rate_raw`. If the alignment cannot account for all
  phones, strict comparison is used and identified in the result. This step uses
  decoded phones, not a second neural inference or a human-validated confidence.
- **Words:** 100 × (1 − word error rate), allowing spelling-identical splits or
  joins of up to three words, such as “today” / “to day”. This measures agreement
  with a machine transcript, not human understanding.
- **Reference similarity:** the OpenPronounce embedding distance mapped using
  its configured `acoustic_good` and distance span. Voice, accent, noise and
  microphone conditions affect this. It is not a measure of speaker quality.

Changing the reference voice changes the acoustic comparison. Calibration against
human-rated recordings remains future work; do not advertise score gains as
validated learning gains. `calibrate.py` can inspect a reference baseline, but
that alone is not human validation.

## Word flags and guidance

OpenPronounce's word flags use its posterior-aware phone report. The internal
confidence is a heuristic, not a calibrated probability of an error. Stronger
flags are prioritized for practice; low-strength flags are described as uncertain.
Unknown detected sounds remain blank rather than echoing the reference.

## Recording quality

Whole-recording RMS below 0.01 (about −40 dBFS) triggers a quiet-recording hint.
At least 1% of samples at absolute amplitude 0.99 or above triggers a possible
clipping hint. These checks are heuristic, do not cover all noise, and do not
change the score. Long silence can lower whole-recording RMS.

Pitch, fluency, rhythm, and word stress are **not** independently graded. Adding
these responsibly needs alignment and evaluation, not extra decorative numbers.

## Session comparisons and privacy

The browser keeps the latest 20 attempt summaries in memory until the practice
page closes. Comparisons require matching phrase, voice and dimension weights.
Retrying one recording updates that take instead of adding a duplicate.
Reports contain phrases, scores and flagged words; they do not contain audio.
Uploaded audio is temporarily decoded on the app server and removed after analysis.
Reference text is sent to ElevenLabs, or gTTS on fallback, and reference audio is
cached on the app server. The microphone recording is analyzed by local models.
