import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';

const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';

export function Modal({ title, eyebrow, onClose, children, footer, size = 'md' }: { title: string; eyebrow: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; size?: 'md' | 'lg' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(node => node.offsetParent !== null);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }}>
      <header className="modal-header">
        <div><p className="eyebrow">{eyebrow}</p><h2 id="modal-title">{title}</h2></div>
        <button type="button" className="icon-button" aria-label="關閉視窗" onClick={onClose}><Icon name="close"/></button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>;
}

export function Notice({ notice }: { notice: { text: string; error: boolean } | null }) {
  if (!notice) return null;
  return <div className={`toast ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>
    <Icon name={notice.error ? 'alert' : 'check'} size={16}/><span>{notice.text}</span>
  </div>;
}
