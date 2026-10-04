import { useRef, type PointerEvent } from 'react';
import hero from '../assets/hero.png';
import Brand from '../components/Brand';

const APP_NAME = 'Speech Clarity'; // placeholder: change the product name here

const CARDS = [
  { id: 'practice', size: 'a', pos: '20% 60%', title: 'Pronunciation practice', text: 'Read a sentence aloud and see which sounds differ from a clear reference voice.', cta: 'Start practising' },
  { id: 'accents', size: 'b', pos: '85% 40%', title: 'Accent training', text: 'American English is live. British and other accents are planned.', cta: 'Coming soon' },
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
          <div className="lp-links"><a href="#products">Products</a><a href="#about">About us</a><a href="#careers">Careers</a></div>
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
            {c.cta && <button className="btn primary" disabled={c.id === 'accents'} onClick={onStart}>{c.cta}</button>}
          </article>
        ))}
      </section>

      <section className="lp-about" id="about">
        <h2>Quality education, one sound at a time.</h2>
        <p>Clear speech opens doors in school, work and everyday life. {APP_NAME} gives language learners private, instant feedback, which supports UN Sustainable Development Goal 4: inclusive and equitable quality education.</p>
      </section>

      <footer className="lp-foot" id="careers">
        <span>{APP_NAME}</span><span>Careers: coming soon</span>
      </footer>
    </div>
  );
}
