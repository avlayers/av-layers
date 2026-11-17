import { expect, it } from 'vitest';
import { createBufferAccounting } from './gpu-buffers';

class FakeBuffer {}
const ARRAY_BUFFER = 34_962, ELEMENT_ARRAY_BUFFER = 34_963, TRANSFORM_FEEDBACK_BUFFER = 35_982;

class FakeGl {
  readonly ELEMENT_ARRAY_BUFFER = ELEMENT_ARRAY_BUFFER;
  createBuffer() { return new FakeBuffer(); }
  deleteBuffer(_buffer: unknown) {}
  bindBuffer(_target: number, _buffer: unknown) {}
  bindBufferBase(_target: number, _index: number, _buffer: unknown) {}
  bindBufferRange(_target: number, _index: number, _buffer: unknown, _offset: number, _size: number) {}
  bindVertexArray(_vao: unknown) {}
  deleteVertexArray(_vao: unknown) {}
  bufferData(_target: number, _data: unknown, _usage?: number, _srcOffset?: number, _length?: number) {}
  bufferSubData() {}
}

const fixture = () => {
  const accounting = createBufferAccounting([FakeGl.prototype]);
  return { accounting, gl: new FakeGl() };
};

it('counts buffer storage from array, indexed and offset writes', () => {
  const { accounting, gl } = fixture();
  const array = gl.createBuffer(), indexed = gl.createBuffer();
  gl.bindBuffer(ARRAY_BUFFER, array);
  gl.bufferData(ARRAY_BUFFER, new Uint8Array(16));
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 16, buffers: 2, peakBufferBytes: 16, peakBuffers: 2 });
  gl.bindBufferBase(TRANSFORM_FEEDBACK_BUFFER, 0, indexed);
  gl.bufferData(TRANSFORM_FEEDBACK_BUFFER, new Float32Array(4));
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 32, buffers: 2 });
  const data = new Uint8Array(32);
  gl.bindBuffer(ARRAY_BUFFER, array);
  gl.bufferData(ARRAY_BUFFER, data, 0, 8, 8);
  expect(accounting.snapshot().bufferBytes).toBe(24);
  gl.bufferData(ARRAY_BUFFER, data, 0, 8, 0);
  expect(accounting.snapshot().bufferBytes).toBe(40);
  gl.deleteBuffer(indexed);
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 24, buffers: 1 });
  accounting.resetPeaks();
  expect(accounting.snapshot().peakBufferBytes).toBe(24);
});

it('tracks VAO element-buffer bindings across switches', () => {
  const { accounting, gl } = fixture();
  const vao = {}, first = gl.createBuffer(), second = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, first);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, new Uint8Array(24));
  gl.bindVertexArray(null);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, second);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, new Uint8Array(12));
  gl.bindVertexArray(vao);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, new Uint8Array(8));
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 20, buffers: 2 });
});

it('restores the default element binding when the current VAO is deleted', () => {
  const { accounting, gl } = fixture();
  const vao = {}, fallback = gl.createBuffer(), vaoBuffer = gl.createBuffer();
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, fallback);
  gl.bindVertexArray(vao);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, vaoBuffer);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, new Uint8Array(24));
  gl.deleteVertexArray(vao);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, new Uint8Array(12));
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 36, buffers: 2 });
});

it('forgets live buffers after context loss while keeping peaks', () => {
  const { accounting, gl } = fixture();
  const buffer = gl.createBuffer();
  gl.bindBuffer(ARRAY_BUFFER, buffer);
  gl.bufferData(ARRAY_BUFFER, new Uint8Array(16));
  accounting.forgetAll();
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 0, buffers: 0, peakBufferBytes: 16 });
});

it('forgets only the lost context', () => {
  const accounting = createBufferAccounting([FakeGl.prototype]), first = new FakeGl(), second = new FakeGl();
  const a = first.createBuffer(), b = second.createBuffer();
  first.bindBuffer(ARRAY_BUFFER, a); first.bufferData(ARRAY_BUFFER, new Uint8Array(16));
  second.bindBuffer(ARRAY_BUFFER, b); second.bufferData(ARRAY_BUFFER, new Uint8Array(24));
  accounting.forget(first as unknown as WebGL2RenderingContext);
  expect(accounting.snapshot()).toMatchObject({ bufferBytes: 24, buffers: 1 });
});
