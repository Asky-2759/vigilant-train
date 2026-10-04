import { useEffect, useRef, useState } from 'react';

type Phone = { expected: string; heard: string; confidence: number };
type Word = { position: number; word: string; expected: string; heard: string; status: 'ok' | 'close' | 'wrong'; phones: Phone[] };
type Term = { key: string; label: string; hint: string; value: number; weight: number; detail: string };
type Result = { score: number; transcribe: string; heard_ipa: string; has_reference: boolean; reference_error?: string;
  band: { label: string; status: string }; breakdown: Term[]; words: Word[] };
type Voice = { id: string; name: string };
type Phase = 'idle' | 'opening' | 'waiting' | 'recording' | 'analyzing';

const THRESHOLD = 500 / 32768; // same volume gate as the desktop recorder
const MAX_MS = 30000;

export default function Practice({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('Three free trees.');
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [phase, setPhase] = useState<Phase>('idle');
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Checking the analysis service');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [clip, setClip] = useState('');
  const [ipa, setIpa] = useState('');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [playing, setPlaying] = useState(false);
  const stop = useRef<() => void>(() => {});
  const cleanup = useRef<() => void>(() => {});
  const voice = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);
  const limit = useRef(400);
  const slow = useRef(0.7);
  const busy = phase !== 'idle';

  useEffect(() => {
    alive.current = true;
    async function health() {
      try {
        const r = await fetch('/api/health');
        if (!r.ok) throw new Error();
        const h = await r.json();
        if (!alive.current) return;
        setReady(h.ready);
        setStatus(h.native?.missing?.length ? `Setup needed: ${h.native.missing.join(', ')}`
          : h.error ? `Models failed to load: ${h.error}`
          : h.ready ? 'Ready' : 'Loading speech models. The first launch can take several minutes.');
      } catch { if (alive.current) { setReady(false); setStatus('Cannot reach the server. Check that it is running.'); } }
    }
    void health();
    const timer = window.setInterval(health, 4000);
    fetch('/api/config').then(r => r.json()).then(c => { limit.current = c.max_text_chars || 400; slow.current = c.slow_speed || 0.7; }).catch(() => {});
    fetch('/api/voices').then(r => r.json()).then(v => { setVoices(v.voices || []); setVoiceId(v.selected || ''); }).catch(() => {});
    return () => { alive.current = false; clearInterval(timer); cleanup.current(); voice.current?.pause(); };
  }, []);

  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip); }, [clip]);

  useEffect(() => { // live IPA preview of the phrase
    const controller = new AbortController();
    let current = true;
    setIpa('');
    const target = text.trim();
    if (!target || target.length > limit.current) { setIpa(''); return; }
    const t = window.setTimeout(async () => {
      try {
        const r = await fetch('/api/phonemes', { method: 'POST', body: new URLSearchParams({ text: target }), signal: controller.signal });
        const body = r.ok ? await r.json() : null;
        if (current && body) setIpa(body.ipa || '');
      } catch { /* the preview is optional */ }
    }, 500);
    return () => { current = false; clearTimeout(t); controller.abort(); };
  }, [text, ready]);

  function play(url: string) {
    voice.current?.pause(); setError(''); setPlaying(true);
    const audio = new Audio(url); voice.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => { setPlaying(false); setError('The reference voice could not be played. Check the voice service setup.'); };
    audio.play().catch(() => { setPlaying(false); setError('Your browser blocked playback. Press the button again.'); });
  }
  const query = (value: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ text: value, ...extra }); if (voiceId) q.set('voice_id', voiceId); return q.toString();
  };
  const speak = (value: string, speed = 1) => play(`/api/tts?${query(value, { speed: String(speed) })}`);
  const replayReference = () => play(`/api/reference?${query(text.trim())}`);

  async function start() {
    const target = text.trim();
    if (!target || target.length > limit.current) { setError(`Enter between 1 and ${limit.current} characters.`); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Recording needs a supported browser on localhost or HTTPS.'); return; }
    setPhase('opening'); setError(''); setResult(null); setClip(''); voice.current?.pause(); setPlaying(false);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (!alive.current) { stream.getTracks().forEach(t => t.stop()); return; }
      context = new AudioContext(); await context.resume();
      if (!alive.current) { stream.getTracks().forEach(t => t.stop()); void context.close(); return; }
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = []; // keep every chunk: dropping the first one drops the WebM header
      let started = mode === 'manual';
      let startTime = performance.now();
      const armedAt = startTime;
      let quietSince: number | null = null;
      let finished = false;
      let timer = 0;
      const release = () => { clearInterval(timer); stream?.getTracks().forEach(t => t.stop()); void context?.close(); };
      const finish = () => { if (finished) return; finished = true; clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop(); };
      stop.current = finish;
      cleanup.current = () => { recorder.onstop = null; finish(); release(); };
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { recorder.onstop = null; finish(); release(); setPhase('idle'); setError('Recording failed. Please try again.'); };
      recorder.onstop = async () => {
        release();
        if (!alive.current) return;
        if (!started) { setPhase('idle'); setError('No sound detected. Try manual mode or move closer to the microphone.'); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        setClip(URL.createObjectURL(blob)); setPhase('analyzing');
        const data = new FormData();
        data.append('file', blob, recorder.mimeType.includes('mp4') ? 'take.mp4' : 'take.webm');
        data.append('expected_text', target);
        if (voiceId) data.append('voice_id', voiceId);
        try {
          const r = await fetch('/api/analyze', { method: 'POST', body: data });
          const body = await r.json();
          if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Scoring failed.');
          if (alive.current) setResult(body);
        } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Scoring failed.'); }
        finally { if (alive.current) setPhase('idle'); }
      };
      recorder.start(100);
      setPhase(started ? 'recording' : 'waiting');
      timer = window.setInterval(() => {
        const now = performance.now();
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
        if (!started) {
          if (rms >= THRESHOLD) { started = true; startTime = now; setPhase('recording'); }
          else if (now - armedAt >= MAX_MS) finish();
        } else {
          if (now - startTime >= MAX_MS) finish();
          if (mode === 'auto') {
            quietSince = rms < THRESHOLD ? quietSince ?? now : null;
            if (quietSince !== null && now - quietSince >= 3000) finish();
          }
        }
      }, 100);
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop()); void context?.close();
      setPhase('idle'); setError(e instanceof Error ? e.message : 'Microphone access failed.');
    }
  }

  const live = phase === 'waiting' || phase === 'recording';
  const hint = phase === 'waiting' ? 'Speak when ready. Waiting up to 30 seconds for sound.'
    : phase === 'recording' ? 'Recording, 30 seconds at most.'
    : phase === 'analyzing' ? 'Scoring your recording.'
    : mode === 'auto' ? 'Waits for sound, then stops after 3 seconds of quiet. Initial waiting audio is retained; background noise can trigger recording.' : 'You start and stop the recording.';

  return (
    <div className="page">
      <header className="bar">
        <button className="mark linkish" onClick={onBack} disabled={busy}>Speech Clarity</button>
        <p className={`status ${ready ? 'ready' : ''}`} role="status">{status}</p>
      </header>
      <main className="work">
        <section className="panel" aria-labelledby="phrase-h">
          <h1 id="phrase-h">Your phrase</h1>
          <textarea aria-label="Phrase to practise" rows={3} value={text} disabled={busy}
            onChange={e => { setText(e.target.value); setResult(null); }} />
          <p className="ipa-preview" aria-live="polite">{ipa ? `/${ipa}/` : 'The phrase in IPA appears here.'}</p>
          <div className="row">
            <button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim())}>Listen</button>
            <button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim(), slow.current)}>Listen slowly</button>
          </div>
          <div className="field">
            <span id="acc-l">Accent</span>
            <div className="chips" role="group" aria-labelledby="acc-l">
              <button className="chip on" aria-pressed="true">American English</button>
              <button className="chip off" disabled>British English, coming soon</button>
            </div>
          </div>
          {voices.length > 0 && <label className="field">Reference voice
            <select value={voiceId} disabled={busy || playing} onChange={e => { setVoiceId(e.target.value); setResult(null); }}>
              {voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></label>}
          <label className="field">Recording
            <select value={mode} disabled={busy} onChange={e => setMode(e.target.value as 'manual' | 'auto')}>
              <option value="manual">Stop Manually</option>
              <option value="auto">Stop automatically</option>
            </select></label>
          {live ? <button className="btn primary wide" onClick={() => stop.current()}>{phase === 'waiting' ? 'Cancel' : 'Stop and score'}</button>
            : <button className="btn primary wide" disabled={busy || !ready || !text.trim()} onClick={start}>
                {phase === 'analyzing' ? 'Scoring' : phase === 'opening' ? 'Opening microphone' : mode === 'auto' ? 'Start listening' : 'Start recording'}</button>}
          <p className="hint" aria-live="polite">{hint}</p>
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        <section className="panel results" aria-labelledby="res-h">
          <h2 id="res-h">Results</h2>
          {clip && <audio controls src={clip} aria-label="Your recording" />}
          {!result && <p className="empty">Record your phrase and your score, the sounds you missed, and a word-by-word comparison appear here.</p>}
          {result && <>
            <div className="score"><span className="num">{Math.round(result.score)}</span><span className="out">out of 100, {result.band.label}</span></div>
            <p className="caveat">Automated estimate, not a confirmed measure of how well people understand you.{!result.has_reference && ' The reference voice was unavailable, so this uses sounds and words only.'}</p>
            <ul className="terms">{result.breakdown.map(t => (
              <li key={t.key}><span>{t.label}</span><span className="bar-track" title={t.hint}><span style={{ width: `${t.value}%` }} /></span><span className="val">{Math.round(t.value)}</span></li>))}
            </ul>
            <h3>Word by word</h3>
            <ul className="gloss">{result.words.map(w => (
              <li key={w.position} className={`w ${w.status}`}>
                <span className="word">{w.word}</span><span className="ipa">/{w.expected}/</span>
                {w.status !== 'ok' && <span className="heard">heard /{w.heard || 'nothing'}/</span>}
                {w.phones.map((p, i) => <span className="heard small" key={i}>Reference {p.expected}; detected {p.heard || 'no sound'}</span>)}
                <button className="linkish small" disabled={playing} onClick={() => speak(w.word)}>Hear it</button>
              </li>))}
            </ul>
            <p className="heard-line"><strong>Recognised:</strong> {result.transcribe || 'nothing'}. <strong>Sounds heard:</strong> /{result.heard_ipa || ''}/</p>
            <div className="row">
              {result.has_reference && <button className="btn" disabled={playing} onClick={replayReference}>Hear the scoring reference</button>}
            </div>
          </>}
        </section>
      </main>
    </div>
  );
}
