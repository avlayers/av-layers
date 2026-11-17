export interface BufferMemory { bufferBytes: number; peakBufferBytes: number; buffers: number; peakBuffers: number }

export type BufferContext = WebGLRenderingContext | WebGL2RenderingContext;
type GL = BufferContext;
interface Binding {
  bindings: Map<number, WebGLBuffer | null>;
  vaos: WeakMap<WebGLVertexArrayObject, WebGLBuffer | null>;
  vao: WebGLVertexArrayObject | null;
  element: WebGLBuffer | null;
}

/** Count live WebGL buffer storage, including indexed and VAO-specific bindings. */
export function createBufferAccounting(prototypes: readonly object[]): { snapshot(): BufferMemory; resetPeaks(): void; forget(gl: BufferContext): void; forgetAll(): void } {
  const allocations = new Map<WebGLBuffer, number>(), owned = new WeakMap<GL, Set<WebGLBuffer>>(), states = new WeakMap<GL, Binding>();
  let peakBytes = 0, peakBuffers = 0;
  const totals = () => { let bufferBytes = 0; for (const bytes of allocations.values()) bufferBytes += bytes; return { bufferBytes, buffers: allocations.size }; };
  const changed = () => { const now = totals(); peakBytes = Math.max(peakBytes, now.bufferBytes); peakBuffers = Math.max(peakBuffers, now.buffers); };
  function state(gl: GL) { let value = states.get(gl); if (!value) { value = { bindings: new Map(), vaos: new WeakMap(), vao: null, element: null }; states.set(gl, value); } return value; }
  const bytesOf = (data: unknown, srcOffset = 0, length?: number) => {
    if (typeof data === 'number') return data;
    if (ArrayBuffer.isView(data)) {
      const element = 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      return length === undefined || length === 0 ? data.byteLength - srcOffset * element : length * element;
    }
    if (data instanceof ArrayBuffer) return length === undefined || length === 0 ? data.byteLength - srcOffset : length;
    return 0;
  };
  function wrap(prototype: object, name: string, after: (gl: GL, args: unknown[], result: unknown) => void) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, name, { ...descriptor, value: function (this: GL, ...args: unknown[]) { const result = Reflect.apply(original, this, args); after(this, args, result); return result; } });
  }
  for (const prototype of prototypes) {
    wrap(prototype, 'createBuffer', (gl, _args, buffer) => { if (!buffer) return; const value = buffer as WebGLBuffer; allocations.set(value, 0); let set = owned.get(gl); if (!set) { set = new Set(); owned.set(gl, set); } set.add(value); changed(); });
    wrap(prototype, 'deleteBuffer', (gl, [buffer]) => { allocations.delete(buffer as WebGLBuffer); owned.get(gl)?.delete(buffer as WebGLBuffer); changed(); });
    wrap(prototype, 'bindBuffer', (gl, [target, buffer]) => {
      const value = buffer as WebGLBuffer | null, current = state(gl), kind = Number(target);
      current.bindings.set(kind, value);
      if (kind === gl.ELEMENT_ARRAY_BUFFER) { if (current.vao) current.vaos.set(current.vao, value); else current.element = value; }
    });
    wrap(prototype, 'bindBufferBase', (gl, [target, , buffer]) => { state(gl).bindings.set(Number(target), buffer as WebGLBuffer | null); });
    wrap(prototype, 'bindBufferRange', (gl, [target, , buffer]) => { state(gl).bindings.set(Number(target), buffer as WebGLBuffer | null); });
    wrap(prototype, 'bindVertexArray', (gl, [vao]) => { const current = state(gl); current.vao = vao as WebGLVertexArrayObject | null; current.bindings.set(gl.ELEMENT_ARRAY_BUFFER, current.vao ? current.vaos.get(current.vao) ?? null : current.element); });
    wrap(prototype, 'deleteVertexArray', (gl, [vao]) => { const current = state(gl); current.vaos.delete(vao as WebGLVertexArrayObject); if (current.vao === vao) { current.vao = null; current.bindings.set(gl.ELEMENT_ARRAY_BUFFER, current.element); } });
    wrap(prototype, 'bufferData', (gl, [target, data, , srcOffset, length]) => {
      const buffer = state(gl).bindings.get(Number(target));
      if (!buffer) return;
      allocations.set(buffer, bytesOf(data, typeof srcOffset === 'number' ? srcOffset : 0, typeof length === 'number' ? length : undefined)); changed();
    });
    wrap(prototype, 'bufferSubData', () => {});
  }
  return { snapshot: () => ({ ...totals(), peakBufferBytes: peakBytes, peakBuffers }), resetPeaks() { const now = totals(); peakBytes = now.bufferBytes; peakBuffers = now.buffers; }, forget(gl) { const set = owned.get(gl); if (!set) return; for (const buffer of set) allocations.delete(buffer); set.clear(); }, forgetAll() { allocations.clear(); } };
}
