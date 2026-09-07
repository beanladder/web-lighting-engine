import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** A collapsible group of fields in the inspector. */
export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="section__head" onClick={() => setOpen(!open)} type="button">
        <span className={'section__caret' + (open ? ' section__caret--open' : '')}>▶</span>
        <span>{title}</span>
      </button>
      {open ? <div className="section__body">{children}</div> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

/**
 * A numeric input that keeps its own draft text while focused, so partial
 * values like "-" or "0." don't get clobbered mid-keystroke. Also doubles as
 * a Blender-style scrubber: click-drag left/right to change the value
 * directly, without ever needing to type. A plain click (no drag) still
 * focuses it for typing, same as any text input.
 */
export function NumberInput({
  value,
  onChange,
  step = 0.1,
  min,
  max,
  precision = 3,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? formatNumber(value, precision);
  const clamp = (next: number) => {
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  const commit = (text: string) => {
    setDraft(null);
    const parsed = Number.parseFloat(text);
    if (Number.isNaN(parsed)) return;
    onChange(clamp(parsed));
  };

  // Drag state lives in a ref, not React state — every pixel of mouse
  // movement would otherwise be a re-render.
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; dragged: boolean } | null>(
    null,
  );
  // Pixels of horizontal movement per `step` of value change. Shift for a
  // tenth of that — Blender's fine-control convention.
  const PIXELS_PER_STEP = 4;

  return (
    <input
      className="input input--number input--scrub"
      type="text"
      inputMode="decimal"
      value={display}
      step={step}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit((event.target as HTMLInputElement).value);
          (event.target as HTMLInputElement).blur();
        } else if (event.key === 'Escape') {
          setDraft(null);
          (event.target as HTMLInputElement).blur();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
          commit(String(value + delta));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Left as a normal click/focus for now — only becomes a scrub once
        // the pointer actually moves past the threshold below.
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, dragged: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - state.startX;
        if (!state.dragged && Math.abs(deltaX) < 3) return;
        if (!state.dragged) {
          state.dragged = true;
          setDraft(null);
          (event.target as HTMLInputElement).blur(); // drop the text caret while scrubbing
        }
        const sensitivity = event.shiftKey ? 0.1 : 1;
        const steps = (deltaX / PIXELS_PER_STEP) * sensitivity;
        onChange(clamp(state.startValue + steps * step));
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        if (state?.pointerId === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        drag.current = null;
      }}
    />
  );
}

function formatNumber(value: number, precision: number) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(precision));
  return String(rounded);
}

export function SliderInput({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  precision = 3,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(Math.max(value, min), max)}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
      />
      <NumberInput value={value} onChange={onChange} step={step} precision={precision} />
    </div>
  );
}

export function Vec3Input({
  value,
  onChange,
  step = 0.05,
  precision = 3,
}: {
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
  step?: number;
  precision?: number;
}) {
  const axes = ['X', 'Y', 'Z'] as const;
  return (
    <div className="vec3">
      {axes.map((axis, index) => (
        <div className="vec3__cell" key={axis}>
          <span className={'vec3__axis axis-' + axis.toLowerCase()}>{axis}</span>
          <NumberInput
            value={value[index]}
            step={step}
            precision={precision}
            onChange={(next) => {
              const copy = [...value] as [number, number, number];
              copy[index] = next;
              onChange(copy);
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />;
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

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
