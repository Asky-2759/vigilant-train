export default function Icon({ name }: { name: 'mic' | 'play' | 'stop' | 'back' | 'spark' | 'check' }) {
 const paths = { mic: 'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8', play: 'm8 4 13 8-13 8Z', stop: 'M5 5h14v14H5Z', back: 'm14 5-7 7 7 7M7 12h14', spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z', check: 'm5 12 4 4L19 6' };
 return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
