import { useEffect, useRef, useState } from 'react';
import { useEngine } from '../state/store';

/**
 * Thumbnail of the baked atlas, so chart packing and seams are visible at a glance.
 *
 * `encodeToCanvas` is duplicated here rather than imported from an exporters
 * module — that module doesn't exist yet (it's a later commit's export
 * pipeline). Once it does, this can share its copy instead.
 */

function linearToSRGB(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function encodeToCanvas(linear: Float32Array, size: number, exposure = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not open a 2D context to encode the atlas.');
  const image = context.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    image.data[i * 4] = Math.round(Math.min(linearToSRGB(linear[i * 3] * exposure), 1) * 255);
    image.data[i * 4 + 1] = Math.round(Math.min(linearToSRGB(linear[i * 3 + 1] * exposure), 1) * 255);
    image.data[i * 4 + 2] = Math.round(Math.min(linearToSRGB(linear[i * 3 + 2] * exposure), 1) * 255);
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export default function AtlasPreview() {
  const bakeResult = useEngine((s) => s.bakeResult);
  const exposure = useEngine((s) => s.bakeSettings.exposure);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bakeResult || !open) return;
    const source = encodeToCanvas(bakeResult.raw, bakeResult.size, exposure);
    canvas.width = bakeResult.size;
    canvas.height = bakeResult.size;
    const context = canvas.getContext('2d');
    if (!context) return;
    // Drawn unflipped, so the thumbnail matches the exported PNG texel for texel.
    context.drawImage(source, 0, 0);
  }, [bakeResult, exposure, open]);

  if (!bakeResult) return null;

  return (
    <div className="atlas-preview">
      {open ? <canvas ref={canvasRef} /> : null}
      <button
        type="button"
        className="atlas-preview__label"
        style={{ width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left' }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '▾' : '▸'} Lightmap atlas · {bakeResult.size}×{bakeResult.size}
      </button>
    </div>
  );
}
