import { useEffect, useRef, useState } from 'react';
import Brand from '../components/Brand';
import Icon from '../components/Icon';
import { createCapture } from '../lib/capture';
import type { Capture } from '../lib/capture';
import { addAttempt, previousComparable, type Attempt } from '../lib/session';

type Word = { position: number; word: string; expected: string; heard: string; status: string; phones: { expected: string; heard: string; confidence: number }[] };
type Result = { sound_comparison?: string; score: number; transcribe: string; heard_ipa: string; has_reference: boolean; words: Word[]; breakdown: {key: string; label: string; value: number; weight: number; hint: string}[]; guidance?: {title: string; message: string; position: number | null}; recording_quality?: {label: string; warnings: string[]; note: string; duration_seconds: number} };
type Take = { id: string; blob: Blob; text: string; voiceId: string; filename: string };
type Phase = 'idle' | 'opening' | 'waiting' | 'recording' | 'analyzing';
const EXAMPLES = ['Three free trees.', 'Very good weather for a walk.', 'She sells seashells by the seashore.'];

export default function Practice({ onBack }: { onBack: () => void }) {
 const [text, setText] = useState(EXAMPLES[0]);
 const [history, setHistory] = useState<Attempt[]>([]);
 const [reportUrl, setReportUrl] = useState('');
 const [currentAttempt, setCurrentAttempt] = useState<Attempt | null>(null);
 const [sentence, setSentence] = useState('');
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
 const [maxUploadBytes, setMaxUploadBytes] = useState(20 * 1024 * 1024);
 const [ipa, setIpa] = useState('');
 const alive = useRef(true);
 const locked = useRef(false);
 const capture = useRef<Capture | null>(null);
 const captureAbort = useRef<AbortController | null>(null);
 const analysisAbort = useRef<AbortController | null>(null);
 const voice = useRef<HTMLAudioElement | null>(null);
 const voiceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const replay = useRef<HTMLAudioElement | null>(null);
 const lastTake = useRef<Take | null>(null);
 const busy = phase !== 'idle';
 const live = phase === 'recording' || phase === 'waiting';

 function stopVoice() {
   clearTimeout(voiceTimer.current);
   const audio = voice.current; voice.current = null;
   if (audio) { audio.onended = audio.onerror = audio.onplaying = null; audio.pause(); audio.removeAttribute('src'); audio.load(); }
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
   void fetch('/api/config', {signal: controller.signal}).then(r => r.json()).then(c => { if (alive.current) { setMaxChars(c.max_text_chars || 400); setMaxUploadBytes(c.max_upload_bytes || 20 * 1024 * 1024); } }).catch(() => {});
   void fetch('/api/voices', {signal: controller.signal}).then(r => r.json()).then(v => { if (alive.current) { setVoices(v.voices || []); setVoiceId(v.selected || ''); } }).catch(() => {});
   return () => { alive.current = false; clearInterval(timer); clearTimeout(voiceTimer.current); controller.abort(); captureAbort.current?.abort(); capture.current?.cancel(); analysisAbort.current?.abort(); const a = voice.current; if (a) { a.onended = a.onerror = a.onplaying = null; a.pause(); a.removeAttribute('src'); a.load(); } };
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
 function changeText(value: string) { setCurrentAttempt(null); setText(value); setResult(null); lastTake.current = null; setClip(''); setError(''); }
 function speak(value: string, speed = 1) {
   stopVoice(); replay.current?.pause(); setError(''); setPlaying(true);
   const params = new URLSearchParams({text: value, speed: String(speed)}); if (voiceId) params.set('voice_id', voiceId);
   const audio = new Audio(`/api/tts?${params}`); voice.current = audio;
   const timer = voiceTimer.current = setTimeout(() => { if (voice.current === audio) { stopVoice(); setError('Reference audio took too long. Please retry.'); } }, 30000);
   const finish = () => { clearTimeout(timer); if (voice.current === audio) setPlaying(false); };
   audio.onplaying = () => clearTimeout(timer);
   audio.onended = finish;
   audio.onerror = () => { finish(); if (voice.current === audio) setError('Reference voice unavailable. You can still record.'); };
   void audio.play().catch(() => { finish(); if (voice.current === audio) setError('Could not play the reference. Please retry.'); });
 }
 async function analyze(take: Take) {
   setPhase('analyzing'); setError('');
   const controller = new AbortController(); analysisAbort.current = controller;
   let timedOut = false;
   const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
   const body = new FormData(); body.append('file', take.blob, take.filename); body.append('expected_text', take.text); if (take.voiceId) body.append('voice_id', take.voiceId);
   try {
     const r = await fetch('/api/analyze', {method: 'POST', body, signal: controller.signal});
     const payload = await r.json(); if (!r.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Analysis failed.');
     if (alive.current && !controller.signal.aborted) {
       setResult(payload);
       const focus = payload.words.findIndex((w: Word) => w.position === payload.guidance?.position);
       setSelected(focus >= 0 ? focus : 0);
       const attempt: Attempt = { id: take.id, text: take.text, voiceId: take.voiceId, score: payload.score, hasReference: payload.has_reference, dimensions: payload.breakdown, flagged: payload.words.filter((w: Word) => w.status !== 'ok').map((w: Word) => w.word), createdAt: new Date().toISOString() };
       setHistory(items => addAttempt(items, attempt)); setCurrentAttempt(attempt);
     }
   } catch (e) { if (alive.current) setError(timedOut ? 'Analysis timed out. Your recording is saved below. The server may still be finishing; wait before retrying.' : controller.signal.aborted ? 'Analysis cancelled. Your recording is still available.' : e instanceof Error ? e.message : 'Analysis failed.'); }
   finally { clearTimeout(timer); analysisAbort.current = null; locked.current = false; if (alive.current) setPhase('idle'); }
 }
 async function start() {
   if (locked.current) return;
   if (!text.trim() || text.length > maxChars) { setError(`Enter 1–${maxChars} characters.`); return; }
   if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setError('Microphone capture needs a supported browser on localhost or HTTPS.'); return; }
   locked.current = true; capture.current?.cancel(); captureAbort.current?.abort();
   setCurrentAttempt(null); setPhase('opening'); setError(''); setResult(null); setClip(''); setSeconds(0); setLevel(0); lastTake.current = null; stopVoice(); replay.current?.pause();
   const controller = new AbortController(); captureAbort.current = controller;
   const target = text.trim(); const chosenVoice = voiceId;
   try {
     const session = await createCapture({ automatic: mode === 'auto', signal: controller.signal,
       onPhase: setPhase, onMeter: (l, s) => { setLevel(l); setSeconds(s); },
       onError: message => { locked.current = false; setPhase('idle'); setLevel(0); setError(message); },
       onComplete: blob => {
         capture.current = null; setLevel(0);
         if (!blob) { locked.current = false; setPhase('idle'); setError('No sound detected. Try manual mode or check your microphone.'); return; }
         setClip(URL.createObjectURL(blob)); const take = {id: crypto.randomUUID(), blob, text: target, voiceId: chosenVoice, filename: blob.type.includes('mp4') ? 'take.mp4' : 'take.webm'}; lastTake.current = take; void analyze(take);
       }
     });
     if (controller.signal.aborted) session.cancel(); else capture.current = session;
   } catch (e) { if (captureAbort.current !== controller) return; locked.current = false; if (alive.current) { setPhase('idle'); if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Microphone unavailable.'); } }
 }
 function upload(file: File | undefined) {
   if (!file || locked.current) return;
   if (!file.size || file.size > maxUploadBytes) { setError(`Choose a non-empty audio file smaller than ${Math.round(maxUploadBytes / 1024 / 1024)} MB.`); return; }
   if (!text.trim() || text.length > maxChars) { setError('Enter the words in the recording first.'); return; }
   locked.current = true; stopVoice(); replay.current?.pause(); setResult(null); setCurrentAttempt(null); setError('');
   const take: Take = {id: crypto.randomUUID(), blob: file, text: text.trim(), voiceId, filename: file.name};
   lastTake.current = take; setClip(URL.createObjectURL(file)); void analyze(take);
 }
 function cancelOpening() { captureAbort.current?.abort(); locked.current = false; setPhase('idle'); }
 const previous = currentAttempt ? previousComparable(history, currentAttempt) : undefined;
 const word = result?.words[selected];
 function practiseWord(value: string) { if (!sentence) setSentence(text); changeText(value); }
 useEffect(() => {
   if (!history.length) { setReportUrl(''); return; }
   const data = { app: 'Speech Clarity', exportedAt: new Date().toISOString(), note: 'Uncalibrated model estimates. Compare only the same phrase, reference voice and scoring dimensions.', attempts: history };
   const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
   setReportUrl(url);
   return () => URL.revokeObjectURL(url);
 }, [history]);

 const flagged = result?.words.filter(w => w.status !== 'ok').length || 0;
 return <div className="page studio">
   <header className="bar"><button className="brand-button" onClick={onBack} disabled={busy} aria-label="Speech Clarity home"><Brand /></button><span className={`status ${ready ? 'ready' : ''}`} role="status"><i />{status}</span><button className="btn back-button" onClick={onBack} disabled={busy}><Icon name="back" /> Home</button></header>
   <div className="studio-heading"><div><p className="eyebrow">YOUR PERSONAL PRACTICE STUDIO</p><h1>A little practice.<br/><span>A clearer next take.</span></h1><p>Listen closely. Speak naturally. Discover what to try next.</p></div><div className="session-label"><Icon name="spark" /><span>English practice<br/><strong>American reference</strong></span></div></div>
   <main className="work">
     <section className="panel compose" aria-labelledby="phrase-title"><div className="section-heading"><span className="step-number">01</span><div><p className="eyebrow">MAKE IT YOURS</p><h2 id="phrase-title">Choose your phrase</h2></div></div>
       <label className="sr-only" htmlFor="phrase">Sentence to practise</label><textarea id="phrase" rows={4} value={text} disabled={busy || playing} onChange={e => changeText(e.target.value)} /><span className={`character-count ${text.length > maxChars ? 'error' : ''}`}>{text.length} / {maxChars}</span>
       <div className="example-list">{sentence && <button className="example" disabled={busy || playing} onClick={() => { changeText(sentence); setSentence(''); }}>Back to full sentence</button>}{EXAMPLES.map((value, index) => <button key={value} disabled={busy || playing} className="example" onClick={() => changeText(value)}>Try phrase {index + 1}</button>)}</div>
       <div className="reference-row"><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim())}><Icon name="play" /> Listen</button><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim(), 0.7)}>0.7× Slowly</button>{playing && <button className="linkish" onClick={stopVoice}>Stop audio</button>}</div>
       {voices.length > 0 && <label className="field">Reference voice<select value={voiceId} disabled={busy || playing} onChange={e => { setVoiceId(e.target.value); setCurrentAttempt(null); setResult(null); lastTake.current = null; }}>{voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
       {ipa && <details className="sound-details"><summary>Reference sounds · IPA</summary><p>/{ipa}/</p></details>}
       <div className="record-zone"><div className="section-heading"><span className="step-number">02</span><div><p className="eyebrow">SPEAK NATURALLY</p><h2>Your turn</h2></div></div>
         <div className="mode-switch" role="group" aria-label="Recording mode"><button aria-pressed={mode === 'manual'} disabled={busy} onClick={() => setMode('manual')}>Manual</button><button aria-pressed={mode === 'auto'} disabled={busy} onClick={() => setMode('auto')}>Auto silence</button></div>
         <div className={`record-meter ${live ? 'live' : ''}`}><Icon name="mic" /><div className="level-track" aria-label="Microphone input level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{width: `${level * 100}%`}} /></div><span className="clock">{Math.floor(seconds).toString().padStart(2, '0')} / 30s</span></div>
         {live ? <button className="btn primary wide recording" onClick={() => capture.current?.stop()}><Icon name="stop" />{phase === 'waiting' ? 'Cancel listening' : 'Finish recording'}</button> : <button className="btn primary wide" disabled={busy || !ready || !text.trim() || text.length > maxChars} onClick={start}><Icon name="mic" />{phase === 'opening' ? 'Opening microphone…' : phase === 'analyzing' ? 'Reviewing your take…' : result ? 'Record another take' : mode === 'auto' ? 'Start listening' : 'Start recording'}</button>}
         {phase === 'opening' && <button className="linkish" onClick={cancelOpening}>Cancel microphone request</button>}{phase === 'analyzing' && <button className="linkish" onClick={() => analysisAbort.current?.abort()}>Cancel analysis</button>}
         <label className="audio-upload">Or choose an audio recording (up to 60 seconds)<input type="file" accept="audio/*,.wav,.webm,.mp4,.m4a,.mp3,.ogg" disabled={busy || playing || !ready || !text.trim() || text.length > maxChars} onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} /></label>
         <p className="hint" aria-live="polite">{phase === 'waiting' ? 'Waiting for your voice. Please start within 30 seconds.' : phase === 'recording' ? 'Microphone is live. Read the phrase at your own pace.' : mode === 'auto' ? 'Stops after 3 seconds of quiet. Background noise can trigger recording.' : 'Press once to start, then finish when you are done.'}</p>
       </div>
       {error && <p role="alert" className="error error-box">{error}</p>}
     </section>
     <section className="panel results" aria-labelledby="results-title"><div className="section-heading"><span className="step-number">03</span><div><p className="eyebrow">LISTEN. NOTICE. REPEAT.</p><h2 id="results-title">Your feedback</h2></div></div>
       {!result && <div className="results-empty"><span className={`empty-icon ${phase === 'analyzing' ? 'loading' : ''}`}><Icon name={phase === 'analyzing' ? 'spark' : 'mic'} /></span><h3>{phase === 'analyzing' ? 'Finding the details in your voice' : 'Your next step starts here'}</h3><p>{phase === 'analyzing' ? 'We’re comparing the sounds in your take. Your recording is available below.' : 'Record a phrase to see word-level feedback and hear what to practise next.'}</p><div className="empty-steps"><span>Record</span><span>Review</span><span>Try again</span></div></div>}
       {result && <><div className="feedback-summary"><div><span className="eyebrow">MODEL ESTIMATE</span><p className="score-number">{Math.round(result.score)}<small>/100</small></p></div><div><Icon name="check" /><h3>{flagged ? `${flagged} ${flagged === 1 ? 'word' : 'words'} to revisit` : 'No words flagged'}</h3><p>{flagged ? 'Select a highlighted word to compare its sounds.' : 'Try a new phrase, or repeat this one.'}</p></div></div>
         {result.guidance && <div className="next-step"><span className="eyebrow">YOUR NEXT STEP</span><h3>{result.guidance.title}</h3><p>{result.guidance.message}</p>{result.guidance.position !== null && <button className="linkish" onClick={() => setSelected(result.words.findIndex(w => w.position === result.guidance!.position))}>Show this word</button>}</div>}
         {previous && currentAttempt && <p className="progress-note">{Math.round(currentAttempt.score - previous.score) > 0 ? '+' : ''}{Math.round(currentAttempt.score - previous.score)} points compared with your previous comparable take. Small changes may be model variation.</p>}
         <div className="dimension-grid">{result.breakdown.map(t => <article className="dimension" key={t.key}><div><strong>{t.label}</strong><span>{Math.round(t.value)}<small>/100</small></span></div><div className="dimension-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.value} aria-label={t.label}><span style={{width: `${t.value}%`}} /></div><p>{t.hint}</p><small>{Math.round(t.weight * 100)}% of the combined estimate</small></article>)}</div>
         <details className="sound-details"><summary>How the comparison works</summary><p>The combined estimate is a weighted average of these dimensions. Without reference audio, sounds and words are reweighted. These are model estimates, not a certified proficiency assessment. Compare takes using the same phrase and reference voice.</p><p>Sound comparison: {result.sound_comparison === 'variant-aware' ? 'accepted variants and similar sounds receive tolerance; missing words still count.' : 'strict sequence comparison was used for this take.'} Pitch, accent identity and speaking speed are not separate grades. A more detailed display does not make recognition more certain.</p></details>
         {result.recording_quality && <div className="quality-note"><strong>{result.recording_quality.label}</strong><span> · {result.recording_quality.duration_seconds}s</span>{result.recording_quality.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>{result.recording_quality.note}</p></div>}
         <div className="word-picker" aria-label="Word feedback">{result.words.map((w, index) => <button key={w.position} className={`word-pill ${w.status !== 'ok' ? 'flagged' : ''} ${selected === index ? 'selected' : ''}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{w.word}{w.status !== 'ok' && <span aria-label="possible difference"> ·</span>}</button>)}</div>
         {word && <div className="word-detail"><div className="row"><h3>{word.word}</h3><span className="detail-label">{word.status === 'ok' ? 'No difference flagged' : 'Possible sound difference'}</span></div><div className="sound-pair"><div><span>Reference</span><p>/{word.expected}/</p></div><div><span>Detected</span><p>/{word.heard || '—'}/</p></div></div><button className="btn" disabled={playing || busy} onClick={() => speak(word.word)}><Icon name="play" /> Hear this word</button><div className="reference-row"><button className="btn" disabled={playing || busy} onClick={() => speak(word.word, 0.7)}>Hear slowly</button><button className="btn" disabled={playing || busy} onClick={() => practiseWord(word.word)}>Practise this word</button></div><p className="hint">Listen once, repeat the word, then practise it in the full sentence. A flagged sound is a suggestion to review, not proof of a mistake.</p>{word.phones.length > 0 && <ul className="phone-differences">{word.phones.filter(phone => phone.confidence > 0).map((phone, index) => <li key={index}><span>Reference <strong>/{phone.expected || '—'}/</strong></span><span>Detected <strong>/{phone.heard || '—'}/</strong></span></li>)}</ul>}</div>}
         <details className="sound-details"><summary>Transcription and score details</summary><p><strong>Recognized:</strong> {result.transcribe || 'No words recognized'}</p><p>/{result.heard_ipa}/</p><ul className="terms">{result.breakdown.map(t => <li key={t.key}><span>{t.label}</span><span className="bar-track"><span style={{width: `${t.value}%`}} /></span><span>{Math.round(t.value)}</span></li>)}</ul></details>
         <p className="caveat">Automated feedback can miss sounds or flag valid pronunciation variants. Treat it as a practice suggestion.{!result.has_reference && ' Reference comparison was unavailable for this take.'}</p></>}
       {clip && <div className="take-playback"><span className="eyebrow">YOUR LATEST TAKE</span><audio ref={replay} controls src={clip} onPlay={stopVoice} aria-label="Your recording" /><a className="linkish small" href={clip} download={lastTake.current?.filename || 'recording.webm'}>Save recording</a>{error && lastTake.current && !busy && <button className="btn" onClick={() => { if (!locked.current && lastTake.current) { locked.current = true; void analyze(lastTake.current); } }}>Retry analysis</button>}</div>}
     </section>
   </main>
   {history.length > 0 && <section className="session-history" aria-labelledby="history-title"><div className="row"><h2 id="history-title">This practice session</h2><a className="btn" href={reportUrl} download="speech-clarity-session.json">Save report</a><button className="linkish" disabled={busy} onClick={() => { setHistory([]); setCurrentAttempt(null); }}>Clear history</button></div><p className="hint">Last 20 takes, kept only while this practice page stays open. Reports contain phrases and scores, not recordings.</p><ol>{history.map((attempt, index) => <li key={attempt.id}><div><strong>{attempt.text}</strong><p>{attempt.flagged.length ? `${attempt.flagged.length} words to review` : 'No words flagged'} · {attempt.hasReference ? 'With reference' : 'Without reference'}</p></div><span>{Math.round(attempt.score)}/100</span><button className="btn" disabled={busy || playing} onClick={() => { changeText(attempt.text); setVoiceId(attempt.voiceId); setSentence(''); }}>Practise again</button><span className="sr-only">Take {history.length - index}</span></li>)}</ol></section>}
   <footer className="studio-footer">Practice at your pace. Your accent is part of your voice.</footer>
 </div>;
}
