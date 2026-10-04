import { useEffect, useRef, useState } from 'react';
import Brand from '../components/Brand';
import Icon from '../components/Icon';
import { createCapture } from '../lib/capture';
import type { Capture } from '../lib/capture';

type Word = { position: number; word: string; expected: string; heard: string; status: string; phones: { expected: string; heard: string; confidence: number }[] };
type Result = { score: number; transcribe: string; heard_ipa: string; has_reference: boolean; words: Word[]; breakdown: {key: string; label: string; value: number}[] };
type Phase = 'idle' | 'opening' | 'waiting' | 'recording' | 'analyzing';
const EXAMPLES = ['Three free trees.', 'Very good weather for a walk.', 'She sells seashells by the seashore.'];

export default function Practice({ onBack }: { onBack: () => void }) {
 const [text, setText] = useState(EXAMPLES[0]);
 const [mode, setMode] = useState('manual');
 const [phase, setPhase] = useState<Phase>('idle');
 const [ready, setReady] = useState(false);
 const [status, setStatus] = useState('Connecting to the practice studio…');
 const [error, setError] = useState('');
 const [result, setResult] = useState<Result | null>(null);
 const [selected, setSelected] = useState(0);
 const [clip, setClip] = useState('');
 const [voices, setVoices] = useState<{id: string; name: string}[]>([]);
 const [voiceId, setVoiceId] = useState('');
 const [playing, setPlaying] = useState(false);
 const [level, setLevel] = useState(0);
 const [seconds, setSeconds] = useState(0);
 const [maxChars, setMaxChars] = useState(400);
 const [ipa, setIpa] = useState('');
 const alive = useRef(true);
 const locked = useRef(false);
 const capture = useRef<Capture | null>(null);
 const captureAbort = useRef<AbortController | null>(null);
 const analysisAbort = useRef<AbortController | null>(null);
 const voice = useRef<HTMLAudioElement | null>(null);
 const replay = useRef<HTMLAudioElement | null>(null);
 const lastTake = useRef<{blob: Blob; text: string; voiceId: string} | null>(null);
 const busy = phase !== 'idle';
 const live = phase === 'recording' || phase === 'waiting';

 function stopVoice() {
   const audio = voice.current; voice.current = null;
   if (audio) { audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); }
   setPlaying(false);
 }
 useEffect(() => {
   alive.current = true;
   const controller = new AbortController();
   let polling = false;
   async function health() {
     if (polling) return; polling = true;
     try {
       const r = await fetch('/api/health', { signal: controller.signal });
       if (!r.ok) throw new Error();
       const h = await r.json(); if (!alive.current) return;
       setReady(h.ready);
       setStatus(h.native?.missing?.length ? `Setup needed: ${h.native.missing.join(', ')}` : h.error ? `Models could not load: ${h.error}` : h.ready ? 'Ready when you are' : 'Preparing speech models. First launch can take a few minutes.');
     } catch { if (alive.current) { setReady(false); setStatus('Connection lost. Check that your Python server is running.'); } }
     finally { polling = false; }
   }
   void health(); const timer = setInterval(health, 4000);
   void fetch('/api/config', {signal: controller.signal}).then(r => r.json()).then(c => { if (alive.current) setMaxChars(c.max_text_chars || 400); }).catch(() => {});
   void fetch('/api/voices', {signal: controller.signal}).then(r => r.json()).then(v => { if (alive.current) { setVoices(v.voices || []); setVoiceId(v.selected || ''); } }).catch(() => {});
   return () => { alive.current = false; clearInterval(timer); controller.abort(); captureAbort.current?.abort(); capture.current?.cancel(); analysisAbort.current?.abort(); const a = voice.current; if (a) { a.onended = a.onerror = null; a.pause(); a.removeAttribute('src'); a.load(); } };
 }, []);
 useEffect(() => () => { if (clip) URL.revokeObjectURL(clip); }, [clip]);
 useEffect(() => {
   setIpa(''); if (!ready || !text.trim() || text.length > maxChars) return;
   const controller = new AbortController();
   const timer = setTimeout(async () => {
     try { const r = await fetch('/api/phonemes', {method: 'POST', body: new URLSearchParams({text: text.trim()}), signal: controller.signal}); const b = r.ok ? await r.json() : null; if (!controller.signal.aborted && b) setIpa(b.ipa); } catch { /* optional */ }
   }, 500);
   return () => { clearTimeout(timer); controller.abort(); };
 }, [text, ready, maxChars]);
 function changeText(value: string) { setText(value); setResult(null); lastTake.current = null; setClip(''); setError(''); }
 function speak(value: string, speed = 1) {
   stopVoice(); replay.current?.pause(); setError(''); setPlaying(true);
   const params = new URLSearchParams({text: value, speed: String(speed)}); if (voiceId) params.set('voice_id', voiceId);
   const audio = new Audio(`/api/tts?${params}`); voice.current = audio;
   const timer = setTimeout(() => { if (voice.current === audio) { stopVoice(); setError('Reference audio took too long. Please retry.'); } }, 30000);
   const finish = () => { clearTimeout(timer); if (voice.current === audio) setPlaying(false); };
   audio.onended = finish;
   audio.onerror = () => { finish(); if (voice.current === audio) setError('Reference voice unavailable. You can still record.'); };
   void audio.play().catch(() => { finish(); if (voice.current === audio) setError('Could not play the reference. Please retry.'); });
 }
 async function analyze(take: {blob: Blob; text: string; voiceId: string}) {
   setPhase('analyzing'); setError('');
   const controller = new AbortController(); analysisAbort.current = controller;
   let timedOut = false;
   const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
   const body = new FormData(); body.append('file', take.blob, take.blob.type.includes('mp4') ? 'take.mp4' : 'take.webm'); body.append('expected_text', take.text); if (take.voiceId) body.append('voice_id', take.voiceId);
   try {
     const r = await fetch('/api/analyze', {method: 'POST', body, signal: controller.signal});
     const payload = await r.json(); if (!r.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Analysis failed.');
     if (alive.current) { setResult(payload); setSelected(payload.words.findIndex((w: Word) => w.status !== 'ok') >= 0 ? payload.words.findIndex((w: Word) => w.status !== 'ok') : 0); }
   } catch (e) { if (alive.current) setError(timedOut ? 'Analysis timed out. Your recording is saved below. The server may still be finishing; wait before retrying.' : controller.signal.aborted ? 'Analysis cancelled. Your recording is still available.' : e instanceof Error ? e.message : 'Analysis failed.'); }
   finally { clearTimeout(timer); analysisAbort.current = null; locked.current = false; if (alive.current) setPhase('idle'); }
 }
 async function start() {
   if (locked.current) return;
   if (!text.trim() || text.length > maxChars) { setError(`Enter 1–${maxChars} characters.`); return; }
   if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Microphone capture needs a supported browser on localhost or HTTPS.'); return; }
   locked.current = true; capture.current?.cancel(); captureAbort.current?.abort();
   setPhase('opening'); setError(''); setResult(null); setClip(''); setSeconds(0); setLevel(0); lastTake.current = null; stopVoice(); replay.current?.pause();
   const controller = new AbortController(); captureAbort.current = controller;
   const target = text.trim(); const chosenVoice = voiceId;
   try {
     const session = await createCapture({ automatic: mode === 'auto', signal: controller.signal,
       onPhase: setPhase, onMeter: (l, s) => { setLevel(l); setSeconds(s); },
       onError: message => { locked.current = false; setPhase('idle'); setLevel(0); setError(message); },
       onComplete: blob => {
         capture.current = null; setLevel(0);
         if (!blob) { locked.current = false; setPhase('idle'); setError('No sound detected. Try manual mode or check your microphone.'); return; }
         setClip(URL.createObjectURL(blob)); const take = {blob, text: target, voiceId: chosenVoice}; lastTake.current = take; void analyze(take);
       }
     });
     if (controller.signal.aborted) session.cancel(); else capture.current = session;
   } catch (e) { if (captureAbort.current !== controller) return; locked.current = false; if (alive.current) { setPhase('idle'); if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Microphone unavailable.'); } }
 }
 function cancelOpening() { captureAbort.current?.abort(); locked.current = false; setPhase('idle'); }
 const word = result?.words[selected];
 const flagged = result?.words.filter(w => w.status !== 'ok').length || 0;
 return <div className="page studio">
   <header className="bar"><button className="brand-button" onClick={onBack} disabled={busy} aria-label="Speech Clarity home"><Brand /></button><span className={`status ${ready ? 'ready' : ''}`} role="status"><i />{status}</span><button className="btn back-button" onClick={onBack} disabled={busy}><Icon name="back" /> Home</button></header>
   <div className="studio-heading"><div><p className="eyebrow">YOUR PERSONAL PRACTICE STUDIO</p><h1>A little practice.<br/><span>A clearer next take.</span></h1><p>Listen closely. Speak naturally. Discover what to try next.</p></div><div className="session-label"><Icon name="spark" /><span>English practice<br/><strong>American reference</strong></span></div></div>
   <main className="work">
     <section className="panel compose" aria-labelledby="phrase-title"><div className="section-heading"><span className="step-number">01</span><div><p className="eyebrow">MAKE IT YOURS</p><h2 id="phrase-title">Choose your phrase</h2></div></div>
       <label className="sr-only" htmlFor="phrase">Sentence to practise</label><textarea id="phrase" rows={4} value={text} disabled={busy || playing} onChange={e => changeText(e.target.value)} /><span className={`character-count ${text.length > maxChars ? 'error' : ''}`}>{text.length} / {maxChars}</span>
       <div className="example-list">{EXAMPLES.map((value, index) => <button key={value} disabled={busy || playing} className="example" onClick={() => changeText(value)}>Try phrase {index + 1}</button>)}</div>
       <div className="reference-row"><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim())}><Icon name="play" /> Listen</button><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim(), 0.7)}>0.7× Slowly</button>{playing && <button className="linkish" onClick={stopVoice}>Stop audio</button>}</div>
       {voices.length > 0 && <label className="field">Reference voice<select value={voiceId} disabled={busy || playing} onChange={e => { setVoiceId(e.target.value); setResult(null); lastTake.current = null; }}>{voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
       {ipa && <details className="sound-details"><summary>Reference sounds · IPA</summary><p>/{ipa}/</p></details>}
       <div className="record-zone"><div className="section-heading"><span className="step-number">02</span><div><p className="eyebrow">SPEAK NATURALLY</p><h2>Your turn</h2></div></div>
         <div className="mode-switch" role="group" aria-label="Recording mode"><button aria-pressed={mode === 'manual'} disabled={busy} onClick={() => setMode('manual')}>Manual</button><button aria-pressed={mode === 'auto'} disabled={busy} onClick={() => setMode('auto')}>Auto silence</button></div>
         <div className={`record-meter ${live ? 'live' : ''}`}><Icon name="mic" /><div className="level-track" aria-label="Microphone input level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{width: `${level * 100}%`}} /></div><span className="clock">{Math.floor(seconds).toString().padStart(2, '0')} / 30s</span></div>
         {live ? <button className="btn primary wide recording" onClick={() => capture.current?.stop()}><Icon name="stop" />{phase === 'waiting' ? 'Cancel listening' : 'Finish recording'}</button> : <button className="btn primary wide" disabled={busy || !ready || !text.trim() || text.length > maxChars} onClick={start}><Icon name="mic" />{phase === 'opening' ? 'Opening microphone…' : phase === 'analyzing' ? 'Reviewing your take…' : result ? 'Record another take' : mode === 'auto' ? 'Start listening' : 'Start recording'}</button>}
         {phase === 'opening' && <button className="linkish" onClick={cancelOpening}>Cancel microphone request</button>}{phase === 'analyzing' && <button className="linkish" onClick={() => analysisAbort.current?.abort()}>Cancel analysis</button>}
         <p className="hint" aria-live="polite">{phase === 'waiting' ? 'Waiting for your voice. Please start within 30 seconds.' : phase === 'recording' ? 'Microphone is live. Read the phrase at your own pace.' : mode === 'auto' ? 'Stops after 3 seconds of quiet. Background noise can trigger recording.' : 'Press once to start, then finish when you are done.'}</p>
       </div>
       {error && <p role="alert" className="error error-box">{error}</p>}
     </section>
     <section className="panel results" aria-labelledby="results-title"><div className="section-heading"><span className="step-number">03</span><div><p className="eyebrow">LISTEN. NOTICE. REPEAT.</p><h2 id="results-title">Your feedback</h2></div></div>
       {!result && <div className="results-empty"><span className={`empty-icon ${phase === 'analyzing' ? 'loading' : ''}`}><Icon name={phase === 'analyzing' ? 'spark' : 'mic'} /></span><h3>{phase === 'analyzing' ? 'Finding the details in your voice' : 'Your next step starts here'}</h3><p>{phase === 'analyzing' ? 'We’re comparing the sounds in your take. Your recording is available below.' : 'Record a phrase to see word-level feedback and hear what to practise next.'}</p><div className="empty-steps"><span>Record</span><span>Review</span><span>Try again</span></div></div>}
       {result && <><div className="feedback-summary"><div><span className="eyebrow">MODEL ESTIMATE</span><p className="score-number">{Math.round(result.score)}<small>/100</small></p></div><div><Icon name="check" /><h3>{flagged ? `${flagged} ${flagged === 1 ? 'word' : 'words'} to revisit` : 'No words flagged'}</h3><p>{flagged ? 'Select a highlighted word to compare its sounds.' : 'Try a new phrase, or repeat this one.'}</p></div></div>
         <div className="word-picker" aria-label="Word feedback">{result.words.map((w, index) => <button key={w.position} className={`word-pill ${w.status !== 'ok' ? 'flagged' : ''} ${selected === index ? 'selected' : ''}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{w.word}{w.status !== 'ok' && <span aria-label="possible difference"> ·</span>}</button>)}</div>
         {word && <div className="word-detail"><div className="row"><h3>{word.word}</h3><span className="detail-label">{word.status === 'ok' ? 'No difference flagged' : 'Possible sound difference'}</span></div><div className="sound-pair"><div><span>Reference</span><p>/{word.expected}/</p></div><div><span>Detected</span><p>/{word.heard || '—'}/</p></div></div><button className="btn" disabled={playing || busy} onClick={() => speak(word.word)}><Icon name="play" /> Hear this word</button></div>}
         <details className="sound-details"><summary>Transcription and score details</summary><p><strong>Recognized:</strong> {result.transcribe || 'No words recognized'}</p><p>/{result.heard_ipa}/</p><ul className="terms">{result.breakdown.map(t => <li key={t.key}><span>{t.label}</span><span className="bar-track"><span style={{width: `${t.value}%`}} /></span><span>{Math.round(t.value)}</span></li>)}</ul></details>
         <p className="caveat">Automated feedback can miss sounds or flag valid pronunciation variants. Treat it as a practice suggestion.{!result.has_reference && ' Reference comparison was unavailable for this take.'}</p></>}
       {clip && <div className="take-playback"><span className="eyebrow">YOUR LATEST TAKE</span><audio ref={replay} controls src={clip} onPlay={stopVoice} aria-label="Your recording" /><a className="linkish small" href={clip} download={`speech-clarity.${lastTake.current?.blob.type.includes('mp4') ? 'mp4' : 'webm'}`}>Save recording</a>{error && lastTake.current && !busy && <button className="btn" onClick={() => { if (!locked.current && lastTake.current) { locked.current = true; void analyze(lastTake.current); } }}>Retry analysis</button>}</div>}
     </section>
   </main><footer className="studio-footer">Practice at your pace. Your accent is part of your voice.</footer>
 </div>;
}
