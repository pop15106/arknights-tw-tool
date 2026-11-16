import type { ComponentChildren } from 'preact';

export type IconName = 'roster' | 'base' | 'grow' | 'link' | 'settings' | 'plus' | 'download' | 'search' | 'shield' | 'file' | 'image' | 'film'
  | 'arrow' | 'edit' | 'sun' | 'moon' | 'close' | 'alert' | 'check' | 'chevron' | 'database' | 'upload' | 'undo' | 'monitor';

const PATHS: Record<IconName, ComponentChildren> = {
  roster: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  base: <><path d="M3 21V9l9-6 9 6v12M8 21v-7h8v7"/></>,
  grow: <><path d="M4 20h16M7 16v-3m5 3V9m5 7V5"/></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  download: <path d="M12 4v11m-5-5 5 5 5-5M4 19h16"/>,
  upload: <path d="M12 16V5m-5 5 5-5 5 5M4 19h16"/>,
  search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>,
  file: <><path d="M14 3H6v18h12V7l-4-4Zm0 0v4h4M9 12h6m-6 4h4"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3Z"/></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>,
  close: <path d="M6 6l12 12M18 6 6 18"/>,
  alert: <><path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4m0 3v.5"/></>,
  check: <path d="m5 12 4.5 4.5L19 7"/>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/></>,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}
