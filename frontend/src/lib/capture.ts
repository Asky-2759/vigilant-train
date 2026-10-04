/** One recording owns one stream, context and timer. Every exit releases them once. */
export type Capture = { stop: () => void; cancel: () => void };
type Options = {
  automatic: boolean;
  signal: AbortSignal;
  onPhase: (phase: 'waiting' | 'recording') => void;
  onMeter: (level: number, seconds: number) => void;
  onComplete: (blob: Blob | null) => void;
  onError: (message: string) => void;
};
export async function createCapture(options: Options): Promise<Capture> {
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;
  let done = false;
  let stopRequested = false;
  const chunks: Blob[] = [];
  let started = !options.automatic;
  let began = performance.now();
  let armed = began;
  let quiet: number | null = null;

  function release() {
    if (released) return;
    released = true;
    clearInterval(timer);
    options.signal.removeEventListener('abort', cancel);
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    source?.disconnect(); analyser?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
  function cancel() {
    if (done) return;
    done = true;
    if (recorder) {
      recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null;
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* already stopped */ } }
    }
    release();
  }
  function fail(message: string) { if (done) return; cancel(); options.onError(message); }
  function stop() {
    if (done || stopRequested) return;
    stopRequested = true;
    clearInterval(timer);
    if (recorder?.state !== 'inactive') {
      try { recorder?.stop(); } catch { fail('Could not finish this recording. Please retry.'); }
    }
  }
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    // Resume during the original button gesture, before waiting for permissions.
    context = new AudioContext();
    await context.resume();
    if (done) throw new DOMException('Cancelled', 'AbortError');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
    if (done || options.signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      throw new DOMException('Cancelled', 'AbortError');
    }
    analyser = context.createAnalyser(); analyser.fftSize = 2048;
    source = context.createMediaStreamSource(stream); source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = event => { if (!done && event.data.size) chunks.push(event.data); };
    recorder.onerror = () => fail('Microphone recording failed. Check your input device and retry.');
    recorder.onstop = () => {
      if (done) return;
      done = true;
      const blob = new Blob(chunks, { type: recorder!.mimeType });
      release();
      if (!started) options.onComplete(null);
      else if (!blob.size) options.onError('The microphone returned an empty recording. Please retry.');
      else options.onComplete(blob);
    };
    stream.getAudioTracks().forEach(track => { track.onended = () => fail('Microphone disconnected. Reconnect it and try again.'); });
    recorder.start(100);
    began = armed = performance.now();
    options.onPhase(started ? 'recording' : 'waiting');
    timer = setInterval(() => {
      if (done || !analyser) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const now = performance.now();
      options.onMeter(Math.min(1, rms * 8), started ? (now - began) / 1000 : 0);
      if (!started) {
        if (rms >= 500 / 32768) { started = true; began = now; options.onPhase('recording'); }
        else if (now - armed >= 30000) stop();
      } else {
        if (now - began >= 30000) stop();
        if (options.automatic) {
          quiet = rms < 500 / 32768 ? quiet ?? now : null;
          if (quiet !== null && now - quiet >= 3000) stop();
        }
      }
    }, 100);
    return { stop, cancel };
  } catch (error) {
    cancel();
    throw error;
  }
}
