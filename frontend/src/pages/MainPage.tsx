import { useEffect, useRef, useState } from 'react';

interface Language {
  code: string;
  label: string;
}

interface WordResult {
  position: number;
  word: string;
  expected: string;
  heard: string;
  status: string;
  confidence: number;
}

interface ScoreTerm {
  key: string;
  label: string;
  value: number;
  weight: number;
  detail: string;
}

interface AnalysisResult {
  score: number;
  transcribe?: string;
  heard_ipa?: string;
  words: WordResult[];
  feedback?: string;
  ai_feedback?: string | null;
  ai_feedback_error?: string;
  breakdown?: ScoreTerm[];
  band?: { label: string; status: string };
  duration?: number;
  has_reference?: boolean;
  reference_error?: string;
}

const MAX_RECORDING_MS = 30_000;

export default function MainPage() {
  const [languages] = useState<Language[]>([
    { code: 'en', label: 'English' },
  ]);
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [speechText, setSpeechText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [audioUrl, setAudioUrl] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const audioUrlRef = useRef('');
  const unmountedRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (recordingTimerRef.current !== null) {
        window.clearTimeout(recordingTimerRef.current);
      }
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  async function startRecording() {
    const expectedText = speechText.trim();
    if (!expectedText) {
      setErrorMessage('Enter the phrase you want to practise before recording.');
      return;
    }
    if (!selectedLanguage) {
      setErrorMessage('Select a language before recording.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setErrorMessage('Audio recording is not supported in this browser. Try a recent browser over localhost or HTTPS.');
      return;
    }

    setErrorMessage('');
    setResult(null);
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = '';
      setAudioUrl('');
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (unmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = getRecordingMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (!unmountedRef.current) {
          setErrorMessage('The browser could not record audio. Check microphone access and try again.');
        }
        stream?.getTracks().forEach((track) => track.stop());
      };
      recorder.onstop = () => {
        if (recordingTimerRef.current !== null) {
          window.clearTimeout(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        stream?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (!unmountedRef.current) {
          void uploadRecording(blob, expectedText);
        }
      };

      recorder.start(250);
      setIsRecording(true);
      recordingTimerRef.current = window.setTimeout(
        () => stopRecordingRef.current(),
        MAX_RECORDING_MS,
      );
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      if (!unmountedRef.current) {
        setErrorMessage(
          error instanceof Error
            ? `Could not start recording: ${error.message}`
            : 'Could not start recording. Check microphone permissions and try again.',
        );
      }
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    setIsRecording(false);
    setIsAnalyzing(true);
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    recorder.stop();
  }

  stopRecordingRef.current = stopRecording;

  async function uploadRecording(blob: Blob, expectedText: string) {
    if (blob.size === 0) {
      setIsAnalyzing(false);
      setErrorMessage('No audio was captured. Check microphone access and try again.');
      return;
    }

    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    setAudioUrl(url);

    const form = new FormData();
    form.append('file', blob, recordingFilename(blob.type));
    form.append('expected_text', expectedText);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: form,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail = isRecord(body) && typeof body.detail === 'string'
          ? body.detail
          : `Scoring failed (${response.status}).`;
        throw new Error(detail);
      }
      if (!isAnalysisResult(body)) {
        throw new Error('The scoring service returned an unexpected response.');
      }
      if (!unmountedRef.current) setResult(body);
    } catch (error) {
      if (!unmountedRef.current) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Audio scoring failed. Please try again.',
        );
      }
    } finally {
      if (!unmountedRef.current) setIsAnalyzing(false);
    }
  }

  const mispronouncedWords = result?.words.filter((word) => word.status !== 'ok') ?? [];

  return (
    <main style={{ maxWidth: '56rem', margin: '2rem auto', padding: '1.5rem' }}>
      <h1>Speech Clarity</h1>
      <p>Enter a phrase, record yourself saying it, and get pronunciation feedback.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label htmlFor="language-select">Select a language</label>
        <select
          id="language-select"
          value={selectedLanguage}
          onChange={(event) => setSelectedLanguage(event.target.value)}
          disabled={isRecording || isAnalyzing}
        >
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>

      <label htmlFor="speech-input">Phrase to say</label>
      <textarea
        id="speech-input"
        className="speech-input"
        placeholder="Type what you want to say before recording..."
        rows={4}
        value={speechText}
        onChange={(event) => setSpeechText(event.target.value)}
        disabled={isRecording || isAnalyzing}
        style={{ width: 'min(100%, 40rem)', boxSizing: 'border-box' }}
      />
      <style>{`
        .speech-input::placeholder { opacity: 0.5; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={isRecording ? stopRecording : () => void startRecording()}
          disabled={isAnalyzing || (!isRecording && !speechText.trim())}
        >
          {isRecording ? 'Stop recording' : 'Record'}
        </button>
        <span aria-live="polite">
          {isRecording
            ? 'Recording… (maximum 30 seconds)'
            : isAnalyzing
              ? 'Scoring your recording…'
              : ''}
        </span>
      </div>

      {errorMessage && (
        <p role="alert" style={{ color: '#a91d30' }}>{errorMessage}</p>
      )}

      {audioUrl && (
        <section aria-label="Your recording">
          <h2>Your recording</h2>
          <audio controls src={audioUrl}>Your browser cannot play this recording.</audio>
        </section>
      )}

      <section aria-labelledby="evaluation-heading">
        <h2 id="evaluation-heading">Evaluation</h2>
        {!result && !isAnalyzing && (
          <p>Your transcription, pronunciation feedback, and score will appear here.</p>
        )}
        {isAnalyzing && <p role="status">Analysing your pronunciation. This may take a little while.</p>}
        {result && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '2rem', flexWrap: 'wrap' }}>
              <div>
                <p><strong>Transcription:</strong> {result.transcribe || 'No transcription returned'}</p>
                <p><strong>Transcribed phonemes:</strong> {result.heard_ipa || 'No phonemes returned'}</p>
                {typeof result.duration === 'number' && (
                  <p><strong>Recording length:</strong> {result.duration.toFixed(1)} seconds</p>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <p><strong>Overall score</strong></p>
                <p style={{ fontSize: '2rem', fontWeight: 'bold', marginTop: 0 }}>
                  {Math.round(result.score)}%
                </p>
                {result.band && <p>{result.band.label}</p>}
              </div>
            </div>

            {result.breakdown && result.breakdown.length > 0 && (
              <div>
                <h3>Score breakdown</h3>
                <ul>
                  {result.breakdown.map((term) => (
                    <li key={term.key}>
                      <strong>{term.label}:</strong> {Math.round(term.value)}% ({term.detail})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <h3>Word-by-word pronunciation</h3>
            {result.words.length > 0 ? (
              <ul>
                {result.words.map((word) => (
                  <li key={word.position} style={{ marginBottom: '0.5rem' }}>
                    <strong>{word.word}</strong> — {word.status === 'ok' ? 'Good' : word.status === 'close' ? 'Almost' : 'Needs practice'}
                    {' · '}expected /{word.expected || '—'}/
                    {' · '}heard /{word.heard || '—'}/
                  </li>
                ))}
              </ul>
            ) : <p>No word-level results were returned.</p>}

            <h3>Words to practise</h3>
            {mispronouncedWords.length > 0 ? (
              <ul>
                {mispronouncedWords.map((word) => (
                  <li key={word.position}>
                    <strong>{word.word}</strong>: expected /{word.expected || '—'}/, heard /{word.heard || '—'}/
                  </li>
                ))}
              </ul>
            ) : <p>No words were flagged.</p>}

            <section aria-labelledby="ai-feedback-heading">
              <h3 id="ai-feedback-heading">AI pronunciation advice</h3>
              {result.ai_feedback
                ? <p>{result.ai_feedback}</p>
                : <p role="status">{result.ai_feedback_error || 'AI feedback is not available.'}</p>}
            </section>
            {result.feedback && <p><strong>Scoring feedback:</strong> {result.feedback}</p>}
            {result.reference_error && (
              <p>The reference voice was unavailable, so the score used the other pronunciation measures.</p>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function getRecordingMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
}

function recordingFilename(mimeType: string) {
  const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  return `recording.${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (!isRecord(value)) return false;
  return typeof value.score === 'number' && Array.isArray(value.words);
}
