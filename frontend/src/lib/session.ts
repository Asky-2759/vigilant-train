export type Attempt = {
  id: string;
  text: string;
  voiceId: string;
  score: number;
  hasReference: boolean;
  dimensions: { key: string; value: number; weight: number }[];
  flagged: string[];
  createdAt: string;
};

const phraseKey = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

export function comparable(a: Attempt, b: Attempt) {
  return phraseKey(a.text) === phraseKey(b.text) && a.voiceId === b.voiceId &&
    a.hasReference === b.hasReference &&
    JSON.stringify(a.dimensions.map(d => [d.key, d.weight])) ===
    JSON.stringify(b.dimensions.map(d => [d.key, d.weight]));
}

export function addAttempt(history: Attempt[], attempt: Attempt) {
  // Retrying analysis of one recording updates it instead of inventing a new take.
  return [attempt, ...history.filter(item => item.id !== attempt.id)].slice(0, 20);
}

export function previousComparable(history: Attempt[], current: Attempt) {
  return history.find(item => item.id !== current.id && comparable(item, current));
}
