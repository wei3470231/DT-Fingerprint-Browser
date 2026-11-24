/* Runs in the Chromium page realm with DT_CANVAS_SEED supplied by the profile. */
(() => {
  'use strict';

  if (typeof DT_CANVAS_SEED !== 'number') return;
  const seed = DT_CANVAS_SEED >>> 0;
  const marker = Symbol.for('dt.canvas.readback');
  const context = globalThis.CanvasRenderingContext2D?.prototype;
  const canvas = globalThis.HTMLCanvasElement?.prototype;
  if (!context || !canvas || context[marker]) return;
  Object.defineProperty(context, marker, { value: true });

  const nativeRead = context.getImageData;
  const nativeWrite = context.putImageData;
  const nativeDraw = context.drawImage;
  const nativeContext = canvas.getContext;
  const create = globalThis.Document.prototype.createElement;
  const maxSnapshotPixels = 4 * 1024 * 1024;

  function adjust(image, x, y) {
    const pixels = image.data;
    if (!(pixels instanceof Uint8ClampedArray)) return image;
    for (let row = 0; row < image.height; row++) {
      const rowKey = seed ^ Math.imul((y + row) | 0, 0x9e3779b1);
      for (let col = 0; col < image.width; col++) {
        const offset = (row * image.width + col) * 4;
        if (pixels[offset + 3] < 128) continue;
        let hash = rowKey ^ Math.imul((x + col) | 0, 0x85ebca6b);
        hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
        hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
        hash ^= hash >>> 16;
        if ((hash & 7) === 0) {
          const channel = (hash >>> 8) % 3;
          pixels[offset + channel] ^= 1;
        }
      }
    }
    return image;
  }

  function replace(object, name, value) {
    const property = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, { ...property, value });
  }

  replace(context, 'getImageData', function getImageData(x, y, width, height) {
    const result = nativeRead.apply(this, arguments);
    const left = Math.trunc(Number(x)) + Math.min(0, Math.trunc(Number(width)));
    const top = Math.trunc(Number(y)) + Math.min(0, Math.trunc(Number(height)));
    return adjust(result, left, top);
  });

  function snapshot(source) {
    const { width, height } = source;
    if (!width || !height || width * height > maxSnapshotPixels) return null;
    try {
      const copy = create.call(source.ownerDocument, 'canvas');
      copy.width = width;
      copy.height = height;
      const target = nativeContext.call(copy, '2d');
      nativeDraw.call(target, source, 0, 0);
      const pixels = adjust(nativeRead.call(target, 0, 0, width, height), 0, 0);
      nativeWrite.call(target, pixels, 0, 0);
      return copy;
    } catch {
      // Let the original API handle unreadable or cross-origin canvases.
      return null;
    }
  }

  const nativeURL = canvas.toDataURL;
  const nativeBlob = canvas.toBlob;
  replace(canvas, 'toDataURL', function toDataURL() {
    return nativeURL.apply(snapshot(this) || this, arguments);
  });
  replace(canvas, 'toBlob', function toBlob(callback) {
    return nativeBlob.apply(snapshot(this) || this, arguments);
  });
})();
