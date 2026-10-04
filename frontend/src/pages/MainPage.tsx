import { useState } from 'react';

/* Types */

interface Language {
  code: string; // e.g. "en"
  label: string; // e.g. "English"
}

interface EvaluationResult {
  transcription: string;
  transcribedPhonemes: string;
  mispronouncedWords: MispronouncedWord[][][];
  overallScore: number; // 0-100
}

interface MispronouncedWord {
  word: string;
  expected: string; // expected phonemes, e.g. "həˈloʊ"
  heard: string; // phonemes the user actually produced
  ipa: string; // IPA shown in "Hear the words you mispronounced"
}

interface AIFeedback {
  feedbackText: string;
}

export default function MainPage() {

  const [languages] = useState<Language[]>([
    { code: "en", label: "English" }
  ]);
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [speechText, setSpeechText] = useState("");

  const [backendResponse, setBackendResponse] = useState<string>("");
  const [isCallingBackend, setIsCallingBackend] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  /* ---------- Placeholder ---------- */
  async function callBackend() {
    setIsCallingBackend(true);
    setBackendResponse("");

    try {
      const response = await fetch("/api/health");
      if (!response.ok) {
        throw new Error(`Backend request failed (${response.status})`);
      }

      const health = await response.json();
      setBackendResponse(JSON.stringify(health, null, 2));
    } catch (error) {
      setBackendResponse(
        error instanceof Error ? error.message : "Backend request failed"
      );
    } finally {
      setIsCallingBackend(false);
    }
  }

  /* ---------- Render ---------- */
  return (
  <div>
    <h1>Speech Clarity</h1>

    <p style={{ textAlign: 'center' }}>Press the button to start recording</p>
    <div style={{ display: "flex", justifyContent: "center" }}>
      <button
        onClick={() => {
          setIsRecording((recording) => !recording);
          if (!isRecording) {
            void callBackend();
          }
        }}
        disabled={!speechText.trim() || isCallingBackend}
      >
        {isRecording ? "Stop" : "Record"}
      </button>
    </div>

    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <label htmlFor="language-select">Select a language</label>
        <select
          id="language-select"
          value={selectedLanguage}
          onChange={(event) => setSelectedLanguage(event.target.value)}
        >
          <option value="" disabled>Select a language</option>
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="speech-input"
        aria-label="Text to say"
        placeholder="Type what you want to say before recording..."
        rows={4}
        value={speechText}
        onChange={(event) => setSpeechText(event.target.value)}
        style={{ width: "min(100%, 32rem)", boxSizing: "border-box" }}
      />
      <style>{`
        .speech-input::placeholder {
          opacity: 0.5;
        }
      `}</style>
      <section aria-labelledby="evaluation-heading">
        <h2 id="evaluation-heading">Evaluation</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "2rem" }}>
          <div>
            <p><strong>Transcription:</strong> —</p>
            <p><strong>Transcribed phonemes:</strong> —</p>
            <p><strong>Mispronounced words:</strong> —</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <p><strong>Overall score</strong></p>
            <p style={{ fontSize: "2rem", fontWeight: "bold", marginTop: 0 }}>##%</p>
          </div>
        </div>
      </section>
      <section aria-labelledby="ai-feedback-heading">
        <h2 id="ai-feedback-heading">AI feedback</h2>
        <p>TODO: AI feedback goes here</p>
      </section>
      <section aria-labelledby="hear-mispronounced-heading">
        <h2 id="hear-mispronounced-heading">Hear word you mispronounced</h2>
      </section>
    </div>
    {backendResponse && (
      <pre style={{ textAlign: "center" }}>{backendResponse}</pre>
    )}

  </div>
  );
}
