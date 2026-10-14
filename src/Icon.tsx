import type { CSSProperties } from 'react';

export type IconName = 'pin' | 'arrow' | 'minus' | 'chevron' | 'settings' | 'collectors' | 'close' | 'check' | 'error' | 'branch' | 'clock' | 'terminal';
const paths: Record<IconName, string> = {
  pin: 'm7 3 6 0-1 4 3 3v2H5v-2l3-3-1-4Z M10 12v5',
  arrow: 'M5 15 15 5 M6 5h9v9',
  minus: 'M5 10h10',
  chevron: 'm5 7 5 5 5-5',
  settings: 'M8 3h4l.5 2 1.5 1 2-.5 2 3.5-1.5 1.5v2L18 14l-2 3.5-2-.5-1.5 1-.5 2H8l-.5-2-1.5-1-2 .5L2 14l1.5-1.5v-2L2 9l2-3.5 2 .5 1.5-1L8 3Z M13 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  collectors: 'M3 6h14M3 10h14M3 14h14 M5 5v2M11 9v2M8 13v2',
  close: 'm5 5 10 10 M15 5 5 15',
  check: 'm4 10 4 4 8-8',
  error: 'M10 6v5 M10 14v.1 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  branch: 'M5 5v10 M5 10h6a4 4 0 0 0 4-4V5 M7 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M7 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M17 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  clock: 'M10 5v5l3 2 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  terminal: 'm4 6 4 4-4 4 M10 14h6 M2 3h16v14H2Z',
};
export function Icon({ name, className, style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={className} style={style} width="16" height="16" viewBox="0 0 20 22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
