import { useRef, type PointerEvent } from 'react';
import hero from '../assets/hero.png';
import Brand from '../components/Brand';

const APP_NAME = 'Speech Clarity';

const CARDS = [
  { id: 'practice', size: 'a', pos: '20% 60%', title: 'Pronunciation practice', text: 'Read a sentence aloud and see which sounds differ from a clear reference voice.', cta: 'Start practising' },
  { id: 'reference', size: 'b', pos: '85% 40%', title: 'Listen, then try', text: 'Hear an American English reference at normal speed or slow it down.', cta: 'Try a phrase' },
  { id: 'feedback', size: 'b', pos: '50% 90%', title: 'Sound-by-sound feedback', text: 'Every word is marked, with what was heard instead.' },
  { id: 'learn', size: 'a', pos: '70% 20%', title: 'Learning for everyone', text: 'Free to try in your browser, with no equipment beyond a microphone.' },
];

export default function Landing({ onStart }: { onStart: () => void }) {
  const center = useRef<HTMLDivElement>(null);
  function updateShade(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse' || !center.current) return;
    const rect = center.current.getBoundingClientRect();
    const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
    const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
    const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / 160);
    event.currentTarget.style.setProperty('--proximity', proximity.toFixed(3));
  }
  return (
    <div className="lp">
      <div className="lp-strip">Supporting UN Sustainable Development Goal 4: Quality Education. <a href="#about">Learn more</a></div>

      <section className="lp-hero" onPointerMove={updateShade} onPointerLeave={event => event.currentTarget.style.removeProperty('--proximity')}>
        <img src={hero} alt="" />
        <nav className="lp-nav" aria-label="Main">
          <Brand />
          <div className="lp-links"><a href="#products">Products</a><a href="#about">About us</a><a href="#how-it-works">How it works</a></div>
        </nav>
        <div className="lp-center" ref={center}>
          <h1 className="lp-title">Explore {APP_NAME}</h1>
          <p className="lp-sub">Find the sounds you want to practise next.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary big" onClick={onStart}>Get started</button>
            <a className="btn ghost big" href="#products">See what's inside</a>
          </div>
        </div>
      </section>

      <section className="lp-cards" id="products" aria-label="Products">
        {CARDS.map(c => (
          <article key={c.id} className={`lp-card ${c.size}`} style={{ backgroundImage: `url(${hero})`, backgroundPosition: c.pos }}>
            <h2>{c.title}</h2><p>{c.text}</p>
            {c.cta && <button className="btn primary" onClick={onStart}>{c.cta}</button>}
          </article>
        ))}
      </section>

      <section className="lp-about" id="about">
        <h2>Quality education, one sound at a time.</h2>
        <p>Clear speech opens doors in school, work and everyday life. {APP_NAME} gives language learners sound-by-sound practice feedback, which supports UN Sustainable Development Goal 4: inclusive and equitable quality education.</p>
      </section>

      <section className="lp-about" id="how-it-works"><h2>Listen. Record. Review.</h2><p>Choose a phrase, hear the reference, then record your take or upload a short audio file. Review the model's suggestions and practise one word at a time. Your microphone recording is processed by the server running this app; reference text may be sent to ElevenLabs or the fallback voice provider.</p></section>
      <footer className="lp-foot">
        <span>{APP_NAME}</span><span>Built for practice. Your accent is yours.</span>
      </footer>
    </div>
  );
}
