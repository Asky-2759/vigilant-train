import { useEffect, useRef, useState } from 'react';

/* ---------- Types ---------- */

interface Language {
  code: string; // e.g. "en"
  label: string; // e.g. "English"
}

interface EvaluationResult {
  score: number;
  transcribe: string;
  heard_ipa: string;
  words: WordResult[];
  feedback?: string;
  band?: {
    label: string;
    status: string;
  };
}

interface WordResult {
  position: number;
  word: string;
  expected: string;
  heard: string;
  status: "ok" | "wrong" | "close";
}

export default function MainPage() {

  const [languages] = useState<Language[]>([
    { code: "en", label: "English" }
  ]);
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [speechText, setSpeechText] = useState("");

  const [backendResponse, setBackendResponse] = useState<string>("");
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
  const [recordingAudioUrl, setRecordingAudioUrl] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const audioUrlRef = useRef<string | null>(null);

  async function uploadRecording(recording: Blob, expectedText: string) {
    setIsUploading(true);
    setBackendResponse("");

    try {
      const formData = new FormData();
      formData.append("file", recording, "recording.webm");
      formData.append("expected_text", expectedText);

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const detail =
          typeof payload === "object" &&
          payload !== null &&
          "detail" in payload &&
          typeof payload.detail === "string"
            ? payload.detail
            : `Audio analysis failed (${response.status})`;
        throw new Error(detail);
      }

      const result: EvaluationResult = await response.json();
      const nextAudioUrl = URL.createObjectURL(recording);
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      audioUrlRef.current = nextAudioUrl;
      setRecordingAudioUrl(nextAudioUrl);
      setEvaluationResult(result);
    } catch (error) {
      setBackendResponse(
        error instanceof Error ? error.message : "Audio analysis failed"
      );
    } finally {
      setIsUploading(false);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setBackendResponse("Microphone access is not available in this browser.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setBackendResponse("Audio recording is not supported in this browser.");
      return;
    }

    setIsStartingRecording(true);
    setBackendResponse("");
    setEvaluationResult(null);
    const expectedText = speechText.trim();
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      if (!mimeType) {
        throw new Error("This browser cannot record audio in WebM format.");
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const recording = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType,
        });
        recordingChunksRef.current = [];
        stream?.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;
        setIsRecording(false);

        if (recording.size === 0) {
          setBackendResponse("No audio was recorded. Check microphone access and try again.");
          return;
        }
        void uploadRecording(recording, expectedText);
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      setBackendResponse(
        error instanceof Error ? error.message : "Could not start recording"
      );
    } finally {
      setIsStartingRecording(false);
    }
  }

  useEffect(
    () => () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    },
    []
  );

  /* ---------- Render ---------- */
  return (
  <div className="main-page">
    <h1>Speech Clarity</h1>
    <div className="main-content-grid">
      <section className="recording-panel" aria-label="Recording controls">
        <p style={{ textAlign: "center" }}>Press the button to start recording</p>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            onClick={() => {
              if (isRecording) {
                const recorder = mediaRecorderRef.current;
                if (recorder && recorder.state !== "inactive") {
                  recorder.stop();
                }
              } else {
                void startRecording();
              }
            }}
            disabled={
              isUploading ||
              isStartingRecording ||
              (!isRecording && !speechText.trim())
            }
          >
            {isRecording
              ? "Stop"
              : isStartingRecording
                ? "Starting..."
                : isUploading
                  ? "Uploading..."
                  : "Record"}
          </button>
        </div>
        <div className="recording-inputs">
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
          />
        </div>
      </section>
      <section aria-labelledby="evaluation-heading">
        <h2 id="evaluation-heading">Evaluation</h2>
        <div>
          <p><strong>Transcription:</strong> {evaluationResult?.transcribe ?? "—"}</p>
          <p><strong>Transcribed phonemes:</strong> {evaluationResult?.heard_ipa ?? "—"}</p>
          <p><strong>Mispronounced words:</strong>{" "}
            {evaluationResult
              ? evaluationResult.words
                  .filter((word) => word.status !== "ok")
                  .map((word) => word.word)
                  .join(", ") || "None"
              : "—"}
          </p>
        </div>
        <div>
          <p><strong>Overall score</strong></p>
          <p style={{ fontSize: "2rem", fontWeight: "bold", marginTop: 0 }}>
            {evaluationResult ? `${Math.round(evaluationResult.score)}%` : "—"}
          </p>
        </div>
        <section aria-labelledby="hear-mispronounced-heading">
          <h2 id="hear-mispronounced-heading">Hear words you mispronounced</h2>
          {evaluationResult?.words
            .filter((word) => word.status !== "ok")
            .map((word) => (
              <p key={word.position}>
                <strong>{word.word}:</strong> expected {word.expected}, heard {word.heard || "—"}
              </p>
            ))}
        </section>
      </section>
    </div>
    <section className="feedback-panel" aria-labelledby="ai-feedback-heading">
      <h2 id="ai-feedback-heading">AI feedback</h2>
      <p>{evaluationResult?.feedback ?? "Feedback will appear after a recording is analyzed."}</p>
    </section>
    {backendResponse && (
      <p role="alert" style={{ textAlign: "center" }}>{backendResponse}</p>
    )}
    {recordingAudioUrl && (
      <audio controls src={recordingAudioUrl} aria-label="Recorded audio" />
    )}
    <style>{`
      .main-content-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1.5rem;
        align-items: start;
      }
      .recording-inputs {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5rem;
      }
      .recording-inputs textarea {
        width: 100%;
        margin: 0;
      }
      .speech-input::placeholder {
        opacity: 0.5;
      }
      .main-content-grid > section,
      .feedback-panel {
        min-width: 0;
        box-sizing: border-box;
        margin-top: 1.5rem;
      }
      .main-content-grid > section > section {
        margin-top: 1.5rem;
      }
      @media (max-width: 700px) {
        .main-content-grid {
          grid-template-columns: 1fr;
        }
      }
    `}</style>
  </div>
  );
}
