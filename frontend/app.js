/* ───────────────────────────────────────────────────────────────────────────
   Pronunciation Trainer — browser side

   One practice round:
     text in  →  select a phrase  →  hear it  →  record yourself  →  score
   The score and the per-word verdict both come from one
   /api/analyze call; everything else here is presentation.
   ─────────────────────────────────────────────────────────────────────────── */

const MAX_RECORD_MS = 15000;
const RING_RADIUS = 66;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SAMPLE_TEXT = "Thorough preparation rarely feels urgent, yet it is what separates a rehearsed "
  + "talk from an improvised one. She thought the third rehearsal would be enough. "
  + "Which of these words would you squeeze into a single breath?";

const BAND_ICONS = { good: "✓", warning: "~", serious: "!", critical: "✕" };

const $ = (id) => document.getElementById(id);

const el = {
  banner: $("banner"),
  voice: $("voice"), voiceField: $("voice-field"),
  statusDot: document.querySelector(".status-dot"), statusText: $("status-text"),
  theme: $("theme"), footerInfo: $("footer-info"),

  composer: $("composer"), textInput: $("text-input"), loadText: $("load-text"),
  loadSample: $("load-sample"),
  editText: $("edit-text"), readerWrap: $("reader-wrap"), reader: $("reader"),
  selPill: $("sel-pill"),

  practiceEmpty: $("practice-empty"), practiceBody: $("practice-body"),
  clearTarget: $("clear-target"),
  targetPhrase: $("target-phrase"), targetIpa: $("target-ipa"),
  hear: $("hear"), hearSlow: $("hear-slow"), record: $("record"), recordLabel: $("record-label"),
  upload: $("upload"), uploadInput: $("upload-input"),
  recorder: $("recorder"), levelFill: $("level-fill"), timer: $("timer"),
  practiceError: $("practice-error"),

  result: $("result"),
  scoreFigure: $("score-figure"), ringFill: $("ring-fill"), scoreValue: $("score-value"),
  bandIcon: $("band-icon"), bandLabel: $("band-label"), breakdown: $("breakdown"),
  words: $("words"), wordsNote: $("words-note"), wordsHint: $("words-hint"),
  heardText: $("heard-text"), heardIpa: $("heard-ipa"), expectedIpa: $("expected-ipa"),
  playMine: $("play-mine"), playRef: $("play-ref"), refNote: $("ref-note"),
  attemptsBlock: $("attempts-block"), attempts: $("attempts"), attemptsNote: $("attempts-note"),
};

const state = {
  config: null,
  ready: false,
  voiceId: "",
  text: "",
  tokens: [],
  sentences: [],
  target: null,       // { text, start, end }  — start/end are null for a drilled word
  phonemes: null,
  result: null,
  recording: null,    // { recorder, stream, context, raf, startedAt, timer, stopTimer }
  myAudioUrl: null,
  attempts: [],
};

/* ═══════════════════════════════════  API  ═══════════════════════════════ */

async function apiJson(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, body });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `${response.status} ${response.statusText}`);
  return payload;
}

const audioCache = new Map();

/** Fetch audio as a blob so an error arrives as a readable message, not a mute <audio>. */
async function fetchAudio(path) {
  if (audioCache.has(path)) return audioCache.get(path);
  const response = await fetch(path);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try { detail = (await response.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  const url = URL.createObjectURL(await response.blob());
  audioCache.set(path, url);
  return url;
}

const player = new Audio();

async function play(url) {
  player.pause();
  player.currentTime = 0;
  player.src = url;
  await player.play();
}

/* Boot */

async function boot() {
  restoreTheme();
  wireEvents();

  try {
    state.config = await apiJson("/api/config");
  } catch (e) {
    return showBanner(`Cannot reach the server: ${e.message}`, "error");
  }

  describeReference();
  if (state.config.elevenlabs) loadVoices();
  pollHealth();
}

function describeReference() {
  const { reference, elevenlabs, model_id: modelId } = state.config;
  if (elevenlabs) {
    const voice = reference.voice ? `${reference.voice}` : "ElevenLabs";
    el.footerInfo.textContent = `Reference voice: ${voice} · ElevenLabs ${modelId}`;
    if (reference.error) showBanner(`ElevenLabs: ${reference.error}`, "error");
  } else {
    el.footerInfo.textContent = "Reference voice: gTTS (built in)";
    showBanner(
      "No ELEVENLABS_API_KEY set, so the built-in gTTS voice is speaking and scoring the "
      + "reference. Add a key to .env and restart for ElevenLabs.",
    );
  }
}

async function loadVoices() {
  try {
    const { voices, selected } = await apiJson("/api/voices");
    if (!voices.length) return;

    let remembered = null;
    try { remembered = localStorage.getItem("pronounce:voice"); } catch { /* blocked */ }
    state.voiceId = voices.some((voice) => voice.id === remembered) ? remembered : (selected || voices[0].id);
    state.voices = voices;

    el.voice.replaceChildren(...voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name;
      option.selected = voice.id === state.voiceId;
      return option;
    }));
    el.voiceField.hidden = false;
    applyVoiceName();
  } catch (e) {
    console.warn("voice list unavailable", e);
  }
}

function applyVoiceName() {
  const voice = state.voices?.find((one) => one.id === state.voiceId);
  if (voice) state.config.reference.voice = voice.name;
  describeReference();
}

/** Poll until the Wav2Vec2 checkpoints are loaded; recording stays disabled until then. */
async function pollHealth() {
  let health;
  try {
    health = await apiJson("/api/health");
  } catch {
    setStatus("error", "Server unreachable");
    return;
  }

  const missing = health.native?.missing || [];
  if (missing.length) {
    const hints = Object.values(health.native.hints || {}).join("  ·  ");
    showBanner(`Missing system dependency: ${missing.join(", ")}. Install with: ${hints}`, "error");
    setStatus("error", `Missing ${missing.join(", ")}`);
    return;
  }

  if (health.models === "ready") {
    state.ready = true;
    setStatus("ready", "Ready");
    syncRecordButton();
    return;
  }
  if (health.models === "error") {
    setStatus("error", "Models failed");
    showBanner(`The speech models failed to load: ${health.error}`, "error");
    return;
  }

  setStatus("warming", "Loading speech models…");
  setTimeout(pollHealth, 1500);
}

function setStatus(stateName, text) {
  el.statusDot.dataset.state = stateName;
  el.statusText.textContent = text;
}

function showBanner(message, tone = "warning") {
  el.banner.textContent = message;
  el.banner.dataset.tone = tone;
  el.banner.hidden = false;
}

/* Theme  */

function restoreTheme() {
  let saved = null;
  try { saved = localStorage.getItem("pronounce:theme"); } catch { /* blocked */ }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
}

function cycleTheme() {
  const order = [undefined, "light", "dark"];
  const current = document.documentElement.dataset.theme || undefined;
  const next = order[(order.indexOf(current) + 1) % order.length];
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try {
    if (next) localStorage.setItem("pronounce:theme", next);
    else localStorage.removeItem("pronounce:theme");
  } catch { /* blocked */ }
}

/* Reader */

/* Words are matched the way the Python side matches them, so that clicking a word
   in the document practices exactly one of the words the scorer will report. */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

function tokenize(text) {
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(WORD_RE)) {
    if (match.index > cursor) {
      tokens.push({ text: text.slice(cursor, match.index), start: cursor, end: match.index, word: false });
    }
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length, word: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), start: cursor, end: text.length, word: false });
  return tokens;
}

/** Split into sentence spans so each one can carry its own "practice this" control. */
function splitSentences(text) {
  const spans = [];
  const boundary = /[.!?…]+["'”’)\]]*\s*|\n+/g;
  let start = 0;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (text.slice(start, end).trim()) spans.push({ start, end });
    start = end;
  }
  if (text.slice(start).trim()) spans.push({ start, end: text.length });
  return spans.length ? spans : [{ start: 0, end: text.length }];
}

function loadText(text) {
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return;
  state.text = text;
  state.tokens = tokenize(text);
  state.sentences = splitSentences(text);
  renderReader();
  el.composer.hidden = true;
  el.readerWrap.hidden = false;
  el.editText.hidden = false;
}

function renderReader() {
  const fragment = document.createDocumentFragment();

  for (const sentence of state.sentences) {
    const span = document.createElement("span");
    span.className = "sent";
    span.dataset.s = sentence.start;
    span.dataset.e = sentence.end;

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "sent-play";
    playButton.textContent = "▶";
    playButton.title = "Practice this sentence";
    playButton.setAttribute("aria-label", "Practice this sentence");
    span.append(playButton);

    for (const token of state.tokens) {
      if (token.start < sentence.start || token.end > sentence.end) continue;
      if (!token.word) { span.append(document.createTextNode(token.text)); continue; }
      const word = document.createElement("span");
      word.className = "w";
      word.textContent = token.text;
      word.dataset.s = token.start;
      word.dataset.e = token.end;
      span.append(word);
    }
    fragment.append(span);
  }
  el.reader.replaceChildren(fragment);
}

/** The words the current selection touches, snapped out to whole word boundaries. */
function readSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!el.reader.contains(range.commonAncestorContainer)) return null;

  const touched = [...el.reader.querySelectorAll(".w")].filter((word) => range.intersectsNode(word));
  if (!touched.length) return null;

  const start = Math.min(...touched.map((word) => +word.dataset.s));
  const end = Math.max(...touched.map((word) => +word.dataset.e));
  return { start, end, text: state.text.slice(start, end), rect: range.getBoundingClientRect() };
}

function showSelectionPill(selection) {
  const card = el.reader.closest(".card").getBoundingClientRect();
  el.selPill.textContent = `Practice “${truncate(selection.text, 42)}”`;
  el.selPill.hidden = false;
  const pill = el.selPill.getBoundingClientRect();
  const left = selection.rect.left + selection.rect.width / 2 - card.left;
  el.selPill.style.left = `${clamp(left - pill.width / 2, 8, card.width - pill.width - 8)}px`;
  el.selPill.style.top = `${Math.max(4, selection.rect.top - card.top - pill.height - 8)}px`;
}

function hideSelectionPill() {
  el.selPill.hidden = true;
}

/* Target */

async function setTarget(target) {
  state.target = target;
  state.result = null;
  state.phonemes = null;

  el.practiceEmpty.hidden = true;
  el.practiceBody.hidden = false;
  el.clearTarget.hidden = false;
  el.result.hidden = true;
  el.practiceError.hidden = true;
  el.targetPhrase.textContent = target.text;
  el.targetIpa.textContent = "…";
  hideSelectionPill();
  document.getSelection()?.removeAllRanges();

  highlightTarget();
  loadAttempts();
  renderAttempts();

  try {
    const body = new FormData();
    body.append("text", target.text);
    state.phonemes = await apiJson("/api/phonemes", { method: "POST", body });
    el.targetIpa.textContent = state.phonemes.ipa || "—";
  } catch (e) {
    el.targetIpa.textContent = "";
    showPracticeError(`Could not work out the expected sounds: ${e.message}`);
  }
}

function highlightTarget() {
  for (const word of el.reader.querySelectorAll(".w.is-target")) word.classList.remove("is-target");
  if (!state.target || state.target.start == null) return;
  for (const word of el.reader.querySelectorAll(".w")) {
    if (+word.dataset.s >= state.target.start && +word.dataset.e <= state.target.end) {
      word.classList.add("is-target");
    }
  }
}

function clearTarget() {
  state.target = null;
  state.result = null;
  el.practiceBody.hidden = true;
  el.practiceEmpty.hidden = false;
  el.clearTarget.hidden = true;
  highlightTarget();
}

/* TTS */

function ttsUrl(text, { speed = 1, ipa = null } = {}) {
  const params = new URLSearchParams({ text, speed: String(speed) });
  if (state.voiceId) params.set("voice_id", state.voiceId);
  if (ipa) params.set("ipa", ipa);
  return `/api/tts?${params}`;
}

async function speak(text, options = {}) {
  try {
    await play(await fetchAudio(ttsUrl(text, options)));
  } catch (e) {
    showPracticeError(`Could not speak that: ${e.message}`);
  }
}

/* Recording */

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function extensionFor(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

async function startRecording() {
  if (!state.target || state.recording) return;
  el.practiceError.hidden = true;

  let stream;
  try {
    // Echo cancellation and noise suppression reshape the spectrum, which is
    // exactly what the phone recognizer is reading — so they stay off. Automatic
    // gain stays on, since a recording too quiet to score helps nobody.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (e) {
    showPracticeError(`No microphone: ${e.message}. Grant access and try again.`);
    return;
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    scoreRecording(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
  });

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);

  state.recording = { recorder, stream, context, startedAt: performance.now() };

  const tick = () => {
    if (!state.recording) return;
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const sample of buffer) sum += ((sample - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / buffer.length);
    el.levelFill.style.width = `${clamp(rms * 320, 2, 100)}%`;
    const elapsed = (performance.now() - state.recording.startedAt) / 1000;
    el.timer.textContent = `${elapsed.toFixed(1)}s`;
    state.recording.raf = requestAnimationFrame(tick);
  };

  recorder.start();
  state.recording.raf = requestAnimationFrame(tick);
  state.recording.stopTimer = setTimeout(stopRecording, MAX_RECORD_MS);

  el.recorder.hidden = false;
  el.record.dataset.recording = "true";
  el.recordLabel.textContent = "Stop";
}

function stopRecording() {
  const recording = state.recording;
  if (!recording) return;
  clearTimeout(recording.stopTimer);
  cancelAnimationFrame(recording.raf);
  state.recording = null;

  recording.recorder.stop();
  for (const track of recording.stream.getTracks()) track.stop();
  recording.context.close().catch(() => {});

  el.recorder.hidden = true;
  el.levelFill.style.width = "0%";
  el.record.dataset.recording = "false";
  el.recordLabel.textContent = "Record";
}

/** Score one blob — from the microphone or from a file the user picked. */
async function scoreRecording(blob, filename = null) {
  if (state.myAudioUrl) URL.revokeObjectURL(state.myAudioUrl);
  state.myAudioUrl = URL.createObjectURL(blob);

  el.record.disabled = true;
  el.upload.disabled = true;
  el.recordLabel.textContent = "Scoring…";
  setStatus("warming", "Scoring your reading…");

  try {
    const body = new FormData();
    body.append("file", blob, filename || `attempt.${extensionFor(blob.type)}`);
    body.append("expected_text", state.target.text);
    if (state.voiceId) body.append("voice_id", state.voiceId);
    renderResult(await apiJson("/api/analyze", { method: "POST", body }));
    setStatus("ready", "Ready");
  } catch (e) {
    showPracticeError(e.message);
    setStatus("ready", "Ready");
  } finally {
    el.record.disabled = false;
    el.recordLabel.textContent = "Record";
    syncRecordButton();
  }
}

function syncRecordButton() {
  el.record.disabled = !state.ready;
  el.upload.disabled = !state.ready;
  el.record.title = state.ready ? "Record yourself reading the phrase (Space)" : "Still loading the speech models…";
}

function showPracticeError(message) {
  el.practiceError.textContent = message;
  el.practiceError.hidden = false;
}

/* Results */

function renderResult(result) {
  state.result = result;
  el.practiceError.hidden = true;
  el.result.hidden = false;

  renderScore(result);
  renderBreakdown(result);
  renderWords(result);
  renderHeard(result);
  renderCompare(result);

  recordAttempt(result);
  renderAttempts();

  if (result.reference_error) {
    showBanner(
      `Scored without the reference voice (${result.reference_error}), so only the sounds and `
      + "words count toward this score.", "warning",
    );
  }
  el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderScore({ score, band }) {
  el.scoreFigure.style.setProperty("--band-color", `var(--${band.status})`);
  el.ringFill.setAttribute("stroke-dasharray", `${RING_CIRCUMFERENCE}`);
  el.ringFill.setAttribute("stroke-dashoffset", `${RING_CIRCUMFERENCE * (1 - score / 100)}`);
  el.scoreValue.textContent = Math.round(score);
  el.bandIcon.textContent = BAND_ICONS[band.status] || "";
  el.bandLabel.textContent = band.label;
  el.scoreFigure.querySelector("svg").setAttribute(
    "aria-label", `Pronunciation score ${Math.round(score)} out of 100 — ${band.label}`,
  );
}

/* Three meters, one hue: these are magnitudes against a limit, not identities. */
function renderBreakdown({ breakdown }) {
  el.breakdown.replaceChildren(...breakdown.map((term) => {
    const row = document.createElement("div");
    row.className = "term";
    row.innerHTML = `
      <span class="term-label" title="${escapeHtml(term.hint)}">${escapeHtml(term.label)}</span>
      <span class="term-value">${term.value.toFixed(0)}</span>
      <div class="term-track"><div class="term-fill" style="width:${clamp(term.value, 0, 100)}%"></div></div>
      <span class="term-detail">${escapeHtml(term.detail)} · ${Math.round(term.weight * 100)}% of the score</span>`;
    return row;
  }));
}

/* Emphasis: correct words stay in ink, only the flagged ones take a status colour,
   and they always carry a word ("close" / "wrong") plus the sounds in text. */
function renderWords({ words }) {
  const flagged = words.filter((word) => word.status !== "ok");
  el.wordsNote.textContent = flagged.length
    ? `${flagged.length} of ${words.length} need work`
    : `all ${words.length} clear`;
  el.wordsHint.hidden = !flagged.length;

  el.words.replaceChildren(...words.map((word) => buildWordChip(word)));
}

function buildWordChip(word) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "word";
  chip.dataset.status = word.status;

  const flag = word.status === "wrong" ? "wrong" : word.status === "close" ? "close" : "";
  chip.innerHTML = `
    <span class="word-text">${escapeHtml(word.word)}</span>
    <span class="word-ipa">${escapeHtml(word.expected || "—")}</span>
    ${flag ? `<span class="word-flag">${BAND_ICONS[word.status === "wrong" ? "critical" : "serious"]} ${flag}</span>` : ""}`;

  if (word.status === "ok") {
    chip.disabled = true;
    chip.setAttribute("aria-label", `${word.word}, pronounced correctly`);
    return chip;
  }

  chip.setAttribute("aria-expanded", "false");
  chip.setAttribute("aria-label", `${word.word}, ${flag} — open the sound breakdown`);
  chip.addEventListener("click", () => toggleWordDetail(chip, word));
  return chip;
}

function toggleWordDetail(chip, word) {
  const open = chip.getAttribute("aria-expanded") === "true";
  el.words.querySelectorAll(".phone-detail").forEach((node) => node.remove());
  el.words.querySelectorAll(".word[aria-expanded]").forEach((node) => node.setAttribute("aria-expanded", "false"));
  if (open) return;

  chip.setAttribute("aria-expanded", "true");
  const detail = document.createElement("div");
  detail.className = "phone-detail";

  const phones = word.phones.length
    ? word.phones
    : [{ expected: word.expected, heard: word.heard, confidence: 1 }];

  detail.innerHTML = `
    <p class="phone-legend">Expected sound on top, what was heard underneath.</p>
    <div class="phone-row">${phones.map((phone) => {
      const bad = phone.confidence >= 0.65 ? "true" : phone.confidence > 0 ? "near" : "false";
      const heard = phone.heard || "∅";
      return `<span class="phone" data-bad="${bad}">
                <span>${escapeHtml(phone.expected)}</span>
                <span class="phone-heard" data-empty="${phone.heard ? "false" : "true"}">${escapeHtml(heard)}</span>
              </span>`;
    }).join("")}</div>`;

  const actions = document.createElement("div");
  actions.className = "controls";
  actions.append(
    button("▶ Hear the word", () => speak(word.word)),
    button("🐢 Hear it slowly", () => speak(word.word, { speed: state.config.slow_speed })),
    button("Drill this word", () => setTarget({ text: word.word, start: null, end: null })),
  );
  if (state.config.elevenlabs && word.expected) {
    actions.append(button("Hear the sounds only", () => speak(word.word, { ipa: word.expected })));
  }
  detail.append(actions);
  chip.after(detail);
}

function button(label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "btn btn-secondary";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function renderHeard(result) {
  el.heardText.textContent = (result.transcribe || "").trim().toLowerCase() || "—";
  el.heardIpa.textContent = result.heard_ipa || "—";
  el.expectedIpa.textContent = state.phonemes?.ipa || "—";
}

function renderCompare(result) {
  el.playMine.disabled = !state.myAudioUrl;
  el.refNote.textContent = result.has_reference
    ? `Reference: ${state.config.reference.voice || "built-in voice"} · your reading lasted ${result.duration}s`
    : "No reference recording for this attempt.";
  el.playRef.disabled = !result.has_reference;
}

/* Attempts */

function attemptsKey() {
  return `pronounce:attempts:${state.target?.text || ""}`;
}

function loadAttempts() {
  state.attempts = [];
  try {
    state.attempts = JSON.parse(localStorage.getItem(attemptsKey()) || "[]");
  } catch { /* blocked or corrupt — an empty history is fine */ }
}

function recordAttempt(result) {
  state.attempts.push({ score: result.score, status: result.band.status, at: Date.now() });
  state.attempts = state.attempts.slice(-12);
  try { localStorage.setItem(attemptsKey(), JSON.stringify(state.attempts)); } catch { /* blocked */ }
}

function renderAttempts() {
  const attempts = state.attempts;
  el.attemptsBlock.hidden = attempts.length < 2;
  if (attempts.length < 2) return;

  const best = Math.max(...attempts.map((attempt) => attempt.score));
  el.attemptsNote.textContent = `${attempts.length} on this phrase · best ${Math.round(best)}`;

  el.attempts.replaceChildren(...[...attempts].reverse().map((attempt, index) => {
    const row = document.createElement("div");
    row.className = "attempt";
    row.dataset.current = String(index === 0);
    row.style.setProperty("--attempt-color", `var(--${attempt.status})`);
    row.innerHTML = `
      <span class="attempt-score">${Math.round(attempt.score)}</span>
      <span class="attempt-bar"><i style="width:${clamp(attempt.score, 0, 100)}%"></i></span>
      <span class="attempt-when">${index === 0 ? "just now" : timeAgo(attempt.at)}</span>`;
    return row;
  }));
}

/* Events */

function wireEvents() {
  el.theme.addEventListener("click", cycleTheme);

  el.voice.addEventListener("change", () => {
    state.voiceId = el.voice.value;
    try { localStorage.setItem("pronounce:voice", state.voiceId); } catch { /* blocked */ }
    for (const url of audioCache.values()) URL.revokeObjectURL(url);
    audioCache.clear();
    applyVoiceName();
    // A voice menu you cannot hear is guesswork: say the current phrase in it.
    if (state.target) speak(state.target.text);
  });

  el.loadText.addEventListener("click", () => loadText(el.textInput.value));
  el.editText.addEventListener("click", () => {
    el.textInput.value = state.text;
    el.composer.hidden = false;
    el.readerWrap.hidden = true;
    el.editText.hidden = true;
    hideSelectionPill();
  });
  el.loadSample.addEventListener("click", () => {
    el.textInput.value = SAMPLE_TEXT;
    loadText(SAMPLE_TEXT);
  });

  // One handler for both gestures: a drag offers the phrase, a plain click on a
  // word drills that word.
  el.reader.addEventListener("pointerup", (event) => {
    if (event.target.closest(".sent-play")) return;
    setTimeout(() => {
      const selection = readSelection();
      if (selection) return showSelectionPill(selection);
      hideSelectionPill();
      const word = event.target.closest(".w");
      if (word) setTarget({ text: word.textContent, start: +word.dataset.s, end: +word.dataset.e });
    }, 0);
  });

  el.reader.addEventListener("click", (event) => {
    const play = event.target.closest(".sent-play");
    if (!play) return;
    const sentence = play.closest(".sent");
    const start = +sentence.dataset.s;
    const end = +sentence.dataset.e;
    setTarget({ text: state.text.slice(start, end).trim(), start, end });
  });

  el.reader.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const selection = readSelection();
    if (selection) {
      event.preventDefault();
      setTarget(selection);
    }
  });

  el.selPill.addEventListener("click", () => {
    const selection = readSelection();
    if (selection) setTarget(selection);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".sel-pill") && !event.target.closest("#reader")) hideSelectionPill();
  });

  el.clearTarget.addEventListener("click", clearTarget);
  el.hear.addEventListener("click", () => speak(state.target.text));
  el.hearSlow.addEventListener("click", () => speak(state.target.text, { speed: state.config.slow_speed }));
  el.record.addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
  el.upload.addEventListener("click", () => el.uploadInput.click());
  el.uploadInput.addEventListener("change", () => {
    const file = el.uploadInput.files?.[0];
    el.uploadInput.value = "";
    if (file) scoreRecording(file, file.name);
  });

  el.playMine.addEventListener("click", () => state.myAudioUrl && play(state.myAudioUrl));
  el.playRef.addEventListener("click", async () => {
    const params = new URLSearchParams({ text: state.target.text });
    if (state.voiceId) params.set("voice_id", state.voiceId);
    try {
      await play(await fetchAudio(`/api/reference?${params}`));
    } catch (e) {
      showPracticeError(`Could not load the reference: ${e.message}`);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    if (state.recording) { event.preventDefault(); return stopRecording(); }
    const tag = document.activeElement?.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "INPUT") return;
    if (!state.target || !state.ready) return;
    event.preventDefault();
    startRecording();
  });

}

/* Helpers */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function timeAgo(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

boot();
