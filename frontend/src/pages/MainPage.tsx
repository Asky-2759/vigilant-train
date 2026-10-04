import { useEffect, useRef, useState } from 'react';
import './practice.css';

type Result = { score: number; transcribe: string; heard_ipa: string; has_reference: boolean;
  words: { position: number; word: string; expected: string; heard: string; status: string }[] };

export default function MainPage() {
  const [text, setText] = useState('Three free trees.');
  const [mode, setMode] = useState('manual');
  const [phase, setPhase] = useState('idle');
  const [status, setStatus] = useState('Checking the analysis service…');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [clip, setClip] = useState('');
  const [busyVoice, setBusyVoice] = useState(false);
  const stop = useRef<() => void>(() => {});
  const cleanup = useRef<() => void>(() => {});
  const voice = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);
  const limit = useRef(500);
  const active = phase !== 'idle';

  useEffect(() => {
    alive.current = true;
    async function health() {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error('Backend is unavailable.');
        const h = await response.json();
        if (!alive.current) return;
        setReady(h.ready);
        setStatus(h.native?.missing?.length ? `Setup needed: ${h.native.missing.join(', ')}` :
          h.error ? `Model loading failed: ${h.error}` : h.ready ? 'Ready to practise' : 'Loading speech models. First launch can take several minutes…');
      } catch { if (alive.current) { setReady(false); setStatus('Cannot reach the backend. Check that the Python server is running.'); } }
    }
    void health();
    void fetch('/api/config').then(r => r.json()).then(c => { limit.current = c.max_text_chars || 500; }).catch(() => {});
    const timer = window.setInterval(health, 4000);
    return () => { alive.current = false; clearInterval(timer); cleanup.current(); voice.current?.pause(); };
  }, []);
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip); }, [clip]);

  async function speak(value: string) {
    voice.current?.pause(); setBusyVoice(true); setError('');
    const audio = new Audio(`/api/tts?${new URLSearchParams({ text: value })}`);
    voice.current = audio;
    audio.onended = () => setBusyVoice(false);
    audio.onerror = () => { setBusyVoice(false); setError('Reference audio could not be played. Check the voice service setup.'); };
    try { await audio.play(); } catch { setBusyVoice(false); setError('Could not play reference audio.'); }
  }

  async function start() {
    if (!text.trim() || text.length > limit.current) { setError(`Enter 1–${limit.current} characters.`); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Recording needs a supported browser on localhost or HTTPS.'); return; }
    const target = text.trim();
    setPhase('opening'); setError(''); setResult(null); setClip(''); voice.current?.pause(); setBusyVoice(false);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (!alive.current) { stream.getTracks().forEach(t => t.stop()); return; }
      context = new AudioContext(); await context.resume();
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const recorder = new MediaRecorder(stream);
      // Keep the complete encoded stream: dropping initial WebM chunks drops its header.
      const chunks: Blob[] = [];
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
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { recorder.onstop = null; finish(); release(); setPhase('idle'); setError('Microphone recording failed. Please retry.'); };
      recorder.onstop = async () => {
        release();
        if (!alive.current) return;
        if (!started) { setPhase('idle'); setError('No sound detected. Try manual mode or move closer to the microphone.'); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        setClip(URL.createObjectURL(blob)); setPhase('analyzing');
        const data = new FormData(); data.append('file', blob, recorder.mimeType.includes('mp4') ? 'take.mp4' : 'take.webm'); data.append('expected_text', target);
        try {
          const response = await fetch('/api/analyze', { method: 'POST', body: data });
          const body = await response.json();
          if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Analysis failed.');
          if (alive.current) setResult(body);
        } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Analysis failed.'); }
        finally { if (alive.current) setPhase('idle'); }
      };
      recorder.start(100);
      setPhase(started ? 'recording' : 'waiting');
      timer = window.setInterval(() => {
        const now = performance.now();
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        if (!started) {
          if (rms >= 500 / 32768) { started = true; startTime = now; setPhase('recording'); }
          else if (now - armedAt >= 30000) finish();
        } else {
          if (now - startTime >= 30000) finish();
          if (mode === 'auto') {
            quietSince = rms < 500 / 32768 ? quietSince ?? now : null;
            if (quietSince !== null && now - quietSince >= 3000) finish();
          }
        }
      }, 100);
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop()); void context?.close();
      setPhase('idle'); setError(e instanceof Error ? e.message : 'Microphone access failed.');
    }
  }

  return <main>
    <h1>Speech Clarity</h1><p>Listen, record, and choose a phrase to practise again.</p>
    <p role="status">{status}</p>
    <label htmlFor="phrase">Your practice sentence · English (US reference)</label>
    <textarea id="phrase" rows={4} value={text} disabled={active} onChange={e => { setText(e.target.value); setResult(null); }} />
    <div className="controls">
      <select aria-label="Recording mode" value={mode} disabled={active} onChange={e => setMode(e.target.value)}>
        <option value="manual">Manual start / stop</option><option value="auto">Automatic stop after silence</option>
      </select>
      <button disabled={active || busyVoice || !text.trim()} onClick={() => speak(text)}>Listen to reference</button>
      {phase === 'waiting' || phase === 'recording' ? <button onClick={() => stop.current()}>{phase === 'waiting' ? 'Cancel' : 'Stop and analyse'}</button> :
        <button disabled={active || !ready || !text.trim()} onClick={start}>{phase === 'analyzing' ? 'Analysing…' : phase === 'opening' ? 'Opening microphone…' : mode === 'auto' ? 'Start listening' : 'Start recording'}</button>}
    </div>
    <p aria-live="polite">{phase === 'waiting' ? 'Speak when ready. Waiting up to 30 seconds for sound.' : phase === 'recording' ? 'Recording… maximum 30 seconds.' : phase === 'analyzing' ? 'Processing your recording. You can replay it below.' : 'Automatic mode stops after 3 seconds of quiet; background noise can trigger it.'}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {clip && <section><h2>Your recording</h2><audio controls src={clip} /></section>}
    {result && <section><h2>Practice feedback</h2><p>Model estimate: <strong>{result.score.toFixed(1)}/100</strong></p>
      <p>This is automated feedback, not a confirmed assessment of how people understand you.</p>
      {!result.has_reference && <p>Reference comparison was unavailable; this estimate uses sounds and transcription only.</p>}
      <p><strong>Recognized text:</strong> {result.transcribe || 'None'}</p><p><strong>Detected sounds:</strong> {result.heard_ipa || 'None'}</p>
      <h3>Word comparison</h3><div className="words">{result.words.map(w => <article key={w.position} className={w.status === 'ok' ? '' : 'flagged'}>
        <strong>{w.word}</strong><p>Reference: /{w.expected}/<br/>Detected: /{w.heard || '—'}/</p>
        <small>{w.status === 'ok' ? 'No difference flagged' : 'Consider another attempt'}</small><br/>
        <button disabled={active || busyVoice} onClick={() => speak(w.word)}>Hear reference</button>
      </article>)}</div></section>}
  </main>;
}
