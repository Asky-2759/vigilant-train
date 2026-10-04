import { useEffect, useRef, useState } from 'react';
import Brand from '../components/Brand';
import Icon from '../components/Icon';
import { createCapture } from '../lib/capture';
import type { Capture } from '../lib/capture';
import { addAttempt, previousComparable, type Attempt } from '../lib/session';

type Word = { position: number; word: string; expected: string; heard: string; status: string; phones: { expected: string; heard: string; confidence: number }[] };
type Result = { ai_feedback?: string | null; ai_feedback_error?: string; sound_comparison?: string; score: number; transcribe: string; heard_ipa: string; has_reference: boolean; words: Word[]; breakdown: {key: string; label: string; value: number; weight: number; hint: string}[]; guidance?: {title: string; message: string; position: number | null}; recording_quality?: {label: string; warnings: string[]; note: string; duration_seconds: number} };
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
 const [coachStyle, setCoachStyle] = useState('british');
 const [playful, setPlayful] = useState(true);
 const [autoCoach, setAutoCoach] = useState(true);
 const [coachClip, setCoachClip] = useState('');
 const [coachText, setCoachText] = useState('');
 const [coachError, setCoachError] = useState('');
 const [coachLoading, setCoachLoading] = useState(false);
 const coachAbort = useRef<AbortController | null>(null);
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
   coachAbort.current?.abort(); coachAbort.current = null; setCoachLoading(false);
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
   return () => { alive.current = false; clearInterval(timer); clearTimeout(voiceTimer.current); controller.abort(); coachAbort.current?.abort(); captureAbort.current?.abort(); capture.current?.cancel(); analysisAbort.current?.abort(); const a = voice.current; if (a) { a.onended = a.onerror = a.onplaying = null; a.pause(); a.removeAttribute('src'); a.load(); } };
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
 function changeText(value: string) { setCoachClip(''); setCoachText(''); setCoachError(''); setCurrentAttempt(null); setText(value); setResult(null); lastTake.current = null; setClip(''); setError(''); }
 function speak(value: string, speed = 1, wholeWord = false) {
   stopVoice(); replay.current?.pause(); setError(''); setPlaying(true);
   const params = new URLSearchParams({text: value, speed: String(speed)}); if (wholeWord) params.set('word', 'true'); if (voiceId) params.set('voice_id', voiceId);
   const audio = new Audio(`/api/tts?${params}`); voice.current = audio;
   const timer = voiceTimer.current = setTimeout(() => { if (voice.current === audio) { stopVoice(); setError('Reference audio took too long. Please retry.'); } }, 30000);
   const finish = () => { clearTimeout(timer); if (voice.current === audio) setPlaying(false); };
   audio.onplaying = () => clearTimeout(timer);
   audio.onended = finish;
   audio.onerror = () => { finish(); if (voice.current === audio) setError('Reference voice unavailable. You can still record.'); };
   void audio.play().catch(() => { finish(); if (voice.current === audio) setError('Could not play the reference. Please retry.'); });
 }
 function playCoachClip(source: string) {
   stopVoice(); replay.current?.pause(); setCoachError(''); setPlaying(true);
   const audio = new Audio(source); voice.current = audio;
   const finish = () => { if (voice.current === audio) setPlaying(false); };
   audio.onended = finish;
   audio.onerror = () => { finish(); if (voice.current === audio) setCoachError('Audio could not play. Try replaying your coach.'); };
   void audio.play().catch(() => { finish(); if (voice.current === audio) setCoachError('Your browser paused automatic audio. Tap Replay coach to listen.'); });
 }
 async function hearCoach(feedback: Result | null = result, focusIndex = selected, intent = 'feedback', takeNumber = history.length) {
   stopVoice(); replay.current?.pause(); setCoachError(''); setCoachText(''); setCoachClip(''); setCoachLoading(true); setPlaying(true);
   const controller = new AbortController(); coachAbort.current = controller;
   const timer = setTimeout(() => controller.abort(), 75000);
   try {
     const response = await fetch('/api/coach', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
       body: JSON.stringify({style: coachStyle, playful, intent, take: takeNumber, guidance: feedback?.ai_feedback || feedback?.guidance?.message || '', warning: feedback?.recording_quality?.warnings[0] || '', focus: feedback?.guidance?.position != null || intent === 'simpler' ? feedback?.words[focusIndex]?.word || '' : ''})});
     if (!response.ok) throw new Error('The coach could not prepare that feedback. Please retry.');
     const payload = await response.json();
     if (!alive.current || controller.signal.aborted) return;
     setCoachText(payload.transcript); setCoachError(payload.error || '');
     if (!payload.audio) { setPlaying(false); return; }
     const source = `data:${payload.content_type};base64,${payload.audio}`;
     setCoachClip(source); playCoachClip(source);
   } catch (e) {
     if (alive.current && coachAbort.current === controller) {
       setPlaying(false);
       if (controller.signal.aborted) setCoachError('Coach request stopped. You can try again.');
       else setCoachError(e instanceof Error ? e.message : 'Coach unavailable. Please retry.');
     }
   } finally { clearTimeout(timer); if (coachAbort.current === controller) { coachAbort.current = null; if (alive.current) setCoachLoading(false); } }
 }
 async function analyze(take: Take) {
   setPhase('analyzing'); setError(''); setCoachClip(''); setCoachText(''); setCoachError('');
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
       if (autoCoach) void hearCoach(payload, focus >= 0 ? focus : 0, 'feedback', history.length + 1);
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

 const micLabel = live ? (phase === 'waiting' ? 'Cancel listening' : 'Finish recording') : phase === 'opening' ? 'Opening microphone...' : phase === 'analyzing' ? 'Reviewing your take...' : result ? 'Record another take' : mode === 'auto' ? 'Start listening' : 'Start recording';
 const flagged = result?.words.filter(w => w.status !== 'ok').length || 0;
 return <div className="studio-shell"><div className="page studio">
   <header className="bar"><button className="brand-button" onClick={onBack} disabled={busy} aria-label="Speech Clarity home"><Brand /></button><span className={`status ${ready ? 'ready' : ''}`} role="status"><i />{status}</span><button className="btn back-button" onClick={onBack} disabled={busy}><Icon name="back" /> Home</button></header>
   <div className="studio-heading"><div><p className="eyebrow">THE SPEECH STUDIO</p><h1>Make yourself <span>heard.</span></h1><p>A little practice. A clearer next take.</p></div><div className="session-label"><Icon name="spark" /><span>English practice<br/><strong>American reference</strong></span></div></div>
   <nav className="studio-steps" aria-label="Practice steps"><a href="#phrase-title"><span>01</span> Choose a phrase</a><a className={live ? 'active' : ''} href="#record-title"><span>02</span> Listen & record</a><a className={result ? 'active' : ''} href="#results-title"><span>03</span> Explore feedback</a><div className="session-counter">{history.length} {history.length === 1 ? 'take' : 'takes'} this session</div></nav>
   <main className="work">
     <section className="panel compose" aria-labelledby="phrase-title"><div className="section-heading"><span className="step-number">01</span><div><p className="eyebrow">MAKE IT YOURS</p><h2 id="phrase-title">Choose your phrase</h2></div></div>
       <label className="sr-only" htmlFor="phrase">Sentence to practise</label><textarea id="phrase" rows={4} value={text} disabled={busy || playing} onChange={e => changeText(e.target.value)} /><span className={`character-count ${text.length > maxChars ? 'error' : ''}`}>{text.length} / {maxChars}</span>
       <div className="example-list">{sentence && <button className="example" disabled={busy || playing} onClick={() => { changeText(sentence); setSentence(''); }}>Back to full sentence</button>}{EXAMPLES.map((value, index) => <button key={value} disabled={busy || playing} className="example" onClick={() => changeText(value)}>{['Sound contrasts', 'Everyday English', 'Tongue twister'][index]}</button>)}</div>
       <div className="reference-row"><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim())}><Icon name="play" /> Listen</button><button className="btn" disabled={busy || playing || !text.trim()} onClick={() => speak(text.trim(), 0.7)}>0.7× Slowly</button>{playing && <button className="linkish" onClick={stopVoice}>Stop audio</button>}</div>
       {voices.length > 0 && <label className="field">Reference voice<select value={voiceId} disabled={busy || playing} onChange={e => { setVoiceId(e.target.value); setCurrentAttempt(null); setResult(null); lastTake.current = null; }}>{voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
       {ipa && <details className="sound-details"><summary>Reference sounds · IPA</summary><p>/{ipa}/</p></details>}
       <div className="record-zone"><div className="section-heading"><span className="step-number">02</span><div><p className="eyebrow">SPEAK NATURALLY</p><h2 id="record-title">Your turn</h2></div></div>
         <div className="mode-switch" role="group" aria-label="Recording mode"><button aria-pressed={mode === 'manual'} disabled={busy} onClick={() => setMode('manual')}>Manual</button><button aria-pressed={mode === 'auto'} disabled={busy} onClick={() => setMode('auto')}>Auto silence</button></div>
         <div className={`capture-stage ${live ? 'is-live' : ''} ${phase === 'analyzing' ? 'is-thinking' : ''}`}><button className={`mic-button ${live ? 'recording' : ''}`} aria-label={micLabel} disabled={!live && (busy || !ready || !text.trim() || text.length > maxChars)} onClick={() => live ? capture.current?.stop() : void start()}><Icon name={live ? 'stop' : phase === 'analyzing' ? 'spark' : 'mic'} /></button><div className="signal-bars" aria-hidden="true">{Array.from({length:23}, (_,i) => <span key={i} style={{height: `${live ? 5 + level * (26 + 32 * Math.abs(Math.sin(i * 1.8))) : 5 + 12 * Math.abs(Math.sin(i * 1.8))}px`}} />)}</div><strong>{micLabel}</strong><span>{live ? 'Read the phrase at your own pace' : 'One phrase. One small step forward.'}</span></div>
         <div className={`record-meter ${live ? 'live' : ''}`}><Icon name="mic" /><div className="level-track" aria-label="Microphone input level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{width: `${level * 100}%`}} /></div><span className="clock">{Math.floor(seconds).toString().padStart(2, '0')} / 30s</span></div>

         {phase === 'opening' && <button className="linkish" onClick={cancelOpening}>Cancel microphone request</button>}{phase === 'analyzing' && <button className="linkish" onClick={() => analysisAbort.current?.abort()}>Cancel analysis</button>}
         <label className="audio-upload">Or choose an audio recording (up to 60 seconds)<input type="file" accept="audio/*,.wav,.webm,.mp4,.m4a,.mp3,.ogg" disabled={busy || playing || !ready || !text.trim() || text.length > maxChars} onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} /></label>
         <p className="hint" aria-live="polite">{phase === 'waiting' ? 'Waiting for your voice. Please start within 30 seconds.' : phase === 'recording' ? 'Microphone is live. Read the phrase at your own pace.' : mode === 'auto' ? 'Stops after 3 seconds of quiet. Background noise can trigger recording.' : 'Press once to start, then finish when you are done.'}</p>
       </div>
       {error && <p role="alert" className="error error-box">{error}</p>}
     </section>
     <section className="panel results" aria-labelledby="results-title"><div className="section-heading"><span className="step-number">03</span><div><p className="eyebrow">LISTEN. NOTICE. REPEAT.</p><h2 id="results-title">Your feedback</h2></div></div>
       <div className={`coach-card ${playing ? 'coach-active' : ''}`}>
         <div className="row"><div><p className="eyebrow">IN YOUR CORNER</p><h3>Your voice coach</h3></div><span className="coach-badge"><Icon name="spark" /> ElevenLabs</span></div>
         <p>Record. Get a little encouragement. Try the next step.</p>
         <div className="coach-controls"><label className="field">Coach voice style<select value={coachStyle} disabled={busy || playing} onChange={e => { setCoachStyle(e.target.value); setCoachText(''); setCoachError(''); }}><option value="british">British · All right, mate</option><option value="american">American · You've got this</option><option value="russian">Russian-accented English</option></select></label><label className="coach-toggle"><input type="checkbox" checked={playful} disabled={busy || playing} onChange={e => { setPlayful(e.target.checked); setCoachText(''); }} /> A little humour</label><label className="coach-toggle"><input type="checkbox" checked={autoCoach} disabled={busy} onChange={e => { setAutoCoach(e.target.checked); if (!e.target.checked) stopVoice(); }} /> Speak after each take</label></div>
         <div className="reference-row"><button className="btn" disabled={busy || playing} onClick={() => void hearCoach()}><Icon name="play" />{coachLoading ? 'Coach is thinking…' : 'Hear my coach'}</button>{playing && <button className="linkish" onClick={stopVoice}>Stop audio</button>}</div>
         <div className="reference-row">{coachClip && <button className="btn" disabled={busy || playing} onClick={() => playCoachClip(coachClip)}>Replay coach</button>}{result && <button className="btn" disabled={busy || playing} onClick={() => void hearCoach(result, selected, 'simpler')}>Make it simpler</button>}{word && <button className="btn" disabled={busy || playing} onClick={() => speak(word.word, 0.7, true)}>Hear “{word.word}”</button>}</div>
         {coachText && <p className="coach-transcript" aria-live="polite">{coachText}</p>}
         {coachError && <p role="status" className="hint">{coachError}</p>}
         <p className="hint">Expressive English coaching; accent delivery can vary. Your pronunciation reference stays American. Feedback follows your latest take.</p>
       </div>
       {!result && <div className="results-empty"><span className={`empty-icon ${phase === 'analyzing' ? 'loading' : ''}`}><Icon name={phase === 'analyzing' ? 'spark' : 'mic'} /></span><h3>{phase === 'analyzing' ? 'Finding the details in your voice' : 'Your next step starts here'}</h3><p>{phase === 'analyzing' ? 'We’re comparing the sounds in your take. Your recording is available below.' : 'Record a phrase to see word-level feedback and hear what to practise next.'}</p><div className="empty-steps"><span>Record</span><span>Review</span><span>Try again</span></div></div>}
       {result && <><div className="feedback-summary"><div className="score-ring" style={{background: `conic-gradient(#245ddd ${Math.max(0,Math.min(100,result.score))}%, #dce6f5 0)`}}><p className="score-number">{Math.round(result.score)}<small>/100</small></p></div><div><span className="eyebrow">MODEL ESTIMATE</span><h3>{flagged ? `${flagged} ${flagged === 1 ? 'word' : 'words'} to revisit` : 'No words flagged'}</h3><p>{flagged ? 'Select a highlighted word to compare its sounds.' : 'Try a new phrase, or repeat this one.'}</p></div></div>
         {result.ai_feedback && <div className="next-step"><span className="eyebrow">AI PRACTICE TIP · GEMINI</span><p>{result.ai_feedback}</p><p className="hint">Based on recognized sounds, which can be wrong. Your voice coach reads this tip automatically.</p></div>}
         {result.ai_feedback_error && <p className="hint" role="status">{result.ai_feedback_error}</p>}
         {result.guidance && <div className="next-step"><span className="eyebrow">YOUR NEXT STEP</span><h3>{result.guidance.title}</h3><p>{result.guidance.message}</p>{result.guidance.position !== null && <button className="linkish" onClick={() => setSelected(result.words.findIndex(w => w.position === result.guidance!.position))}>Show this word</button>}</div>}
         {previous && currentAttempt && <p className="progress-note">{Math.round(currentAttempt.score - previous.score) > 0 ? '+' : ''}{Math.round(currentAttempt.score - previous.score)} points compared with your previous comparable take. Small changes may be model variation.</p>}
         <div className="word-picker" aria-label="Word feedback">{result.words.map((w, index) => <button key={w.position} className={`word-pill ${w.status !== 'ok' ? 'flagged' : ''} ${selected === index ? 'selected' : ''}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{w.word}{w.status !== 'ok' && <span aria-label="possible difference"> ·</span>}</button>)}</div>
         {word && <div className="word-detail"><div className="row"><h3>{word.word}</h3><span className="detail-label">{word.status === 'ok' ? 'No difference flagged' : 'Possible sound difference'}</span></div><div className="sound-pair"><div><span>Reference</span><p>/{word.expected}/</p></div><div><span>Detected</span><p>/{word.heard || '—'}/</p></div></div><button className="btn" disabled={playing || busy} onClick={() => speak(word.word, 1, true)}><Icon name="play" /> Hear this word</button><div className="reference-row"><button className="btn" disabled={playing || busy} onClick={() => speak(word.word, 0.7, true)}>Hear slowly</button><button className="btn" disabled={playing || busy} onClick={() => practiseWord(word.word)}>Practise this word</button></div><p className="hint">The clear word example reads the spelling, not the IPA symbols. Listen once, repeat the word, then practise it in the full sentence. A flagged sound is a suggestion to review, not proof of a mistake.</p>{word.phones.length > 0 && <ul className="phone-differences">{word.phones.filter(phone => phone.confidence > 0).map((phone, index) => <li key={index}><span>Reference <strong>/{phone.expected || '—'}/</strong></span><span>Detected <strong>/{phone.heard || '—'}/</strong></span></li>)}</ul>}</div>}
         <div className="dimension-grid">{result.breakdown.map(t => <article className="dimension" key={t.key}><div><strong>{t.label}</strong><span>{Math.round(t.value)}<small>/100</small></span></div><div className="dimension-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.value} aria-label={t.label}><span style={{width: `${t.value}%`}} /></div><details><summary>What this measures</summary><p>{t.hint}</p></details><small>{Math.round(t.weight * 100)}% of the combined estimate</small></article>)}</div>
         <details className="sound-details"><summary>How the comparison works</summary><p>The combined estimate is a weighted average of these dimensions. Without reference audio, sounds and words are reweighted. These are model estimates, not a certified proficiency assessment. Compare takes using the same phrase and reference voice.</p><p>Sound comparison: {result.sound_comparison === 'variant-aware' ? 'accepted variants and similar sounds receive tolerance; missing words still count.' : 'strict sequence comparison was used for this take.'} Pitch, accent identity and speaking speed are not separate grades. A more detailed display does not make recognition more certain.</p></details>
         {result.recording_quality && <div className="quality-note"><strong>{result.recording_quality.label}</strong><span> · {result.recording_quality.duration_seconds}s</span>{result.recording_quality.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>{result.recording_quality.note}</p></div>}
         <details className="sound-details"><summary>Transcription and score details</summary><p><strong>Recognized:</strong> {result.transcribe || 'No words recognized'}</p><p>/{result.heard_ipa}/</p><ul className="terms">{result.breakdown.map(t => <li key={t.key}><span>{t.label}</span><span className="bar-track"><span style={{width: `${t.value}%`}} /></span><span>{Math.round(t.value)}</span></li>)}</ul></details>
         <p className="caveat">Automated feedback can miss sounds or flag valid pronunciation variants. Treat it as a practice suggestion.{!result.has_reference && ' Reference comparison was unavailable for this take.'}</p></>}
       {clip && <div className="take-playback"><span className="eyebrow">YOUR LATEST TAKE</span><audio ref={replay} controls src={clip} onPlay={stopVoice} aria-label="Your recording" /><a className="linkish small" href={clip} download={lastTake.current?.filename || 'recording.webm'}>Save recording</a>{error && lastTake.current && !busy && <button className="btn" onClick={() => { if (!locked.current && lastTake.current) { locked.current = true; void analyze(lastTake.current); } }}>Retry analysis</button>}</div>}
     </section>
   </main>
   {history.length > 0 && <section className="session-history" aria-labelledby="history-title"><div className="row"><h2 id="history-title">This practice session</h2><a className="btn" href={reportUrl} download="speech-clarity-session.json">Save report</a><button className="linkish" disabled={busy} onClick={() => { setHistory([]); setCurrentAttempt(null); }}>Clear history</button></div><p className="hint">Last 20 takes, kept only while this practice page stays open. Reports contain phrases and scores, not recordings.</p><ol>{history.map((attempt, index) => <li key={attempt.id}><div><strong>{attempt.text}</strong><p>{attempt.flagged.length ? `${attempt.flagged.length} words to review` : 'No words flagged'} · {attempt.hasReference ? 'With reference' : 'Without reference'}</p></div><span>{Math.round(attempt.score)}/100</span><button className="btn" disabled={busy || playing} onClick={() => { changeText(attempt.text); setVoiceId(attempt.voiceId); setSentence(''); }}>Practise again</button><span className="sr-only">Take {history.length - index}</span></li>)}</ol></section>}
   <footer className="studio-footer">Practice at your pace. Your accent is part of your voice.</footer>
 </div></div>;
}
