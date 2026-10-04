import { useState } from 'react';
import Landing from './pages/Landing';
import Practice from './pages/Practice';
import './styles.css';

export default function App() {
  const [page, setPage] = useState<'home' | 'practice'>('home');
  const go = (next: 'home' | 'practice') => { setPage(next); window.scrollTo(0, 0); };
  return page === 'home' ? <Landing onStart={() => go('practice')} /> : <Practice onBack={() => go('home')} />;
}
