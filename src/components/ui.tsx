import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Small, dependency-free editor controls shared by the panels. Grows as the
 * commits that need more of them land — for now just the dropdown menu the
 * File menu uses.
 */

/** Click-to-open dropdown that closes on outside click or Escape. */
export function Menu({
  label,
  children,
  align = 'left',
  disabled,
  className,
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu" ref={container}>
      <button
        type="button"
        className={className ?? 'btn'}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span style={{ fontSize: 8, opacity: 0.7 }}>▼</span>
      </button>
      {open ? (
        <div className={'menu__list' + (align === 'right' ? ' menu__list--right' : '')}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="menu__item" type="button" onClick={onClick} disabled={disabled}>
      <span>{label}</span>
      {hint ? <span className="menu__hint">{hint}</span> : null}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu__sep" />;
