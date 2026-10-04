export default function Landing({ onStart }: { onStart: () => void }) {
  return (
    <div className="page">
      <header className="bar"><span className="mark">Speech Clarity</span></header>
      <main className="hero">
        <div className="hero-text">
          <h1>Find your next sound to practise.</h1>
          <p className="lead">Type a sentence, listen to a clear reference voice, read it aloud, and see sound by sound where your pronunciation differs.</p>
          <button className="btn primary" onClick={onStart}>Get started</button>
        </div>
        <figure className="specimen" aria-label="Example result for the phrase three free trees">
          <ul className="gloss">
            <li className="w close"><span className="word">three</span><span className="ipa">/θɹiː/</span><span className="heard">detected /fɹiː/</span></li>
            <li className="w ok"><span className="word">free</span><span className="ipa">/fɹiː/</span></li>
            <li className="w ok"><span className="word">trees</span><span className="ipa">/tɹiːz/</span></li>
          </ul>
          <figcaption>Example feedback. Underlines flag possible differences for review.</figcaption>
        </figure>
      </main>
      <section className="steps" aria-label="How it works">
        <div><h2>Listen</h2><p>Hear the phrase at normal or slow speed.</p></div>
        <div><h2>Record</h2><p>Read it aloud using your browser's microphone.</p></div>
        <div><h2>Review</h2><p>Explore possible sound differences and replay the reference for any word.</p></div>
      </section>
      <section className="accents-note">
        <h2>Accents</h2>
        <p>Practice currently targets American English. British and other accents are planned.</p>
        <div className="chips"><span className="chip on">American English</span><span className="chip off">British English, coming soon</span></div>
      </section>
    </div>
  );
}
