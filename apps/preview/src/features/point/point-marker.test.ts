import { describe, expect, it } from 'vitest';
import { createPointMarker } from './point-marker';

class StubElement {
  className = '';
  style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parent: StubContainer | null = null;
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

class StubContainer {
  children: StubElement[] = [];
  append(node: StubElement): void {
    node.parent = this;
    this.children.push(node);
  }
}

describe('createPointMarker', () => {
  it('mounts a map dot when a windgram point opens, tracks camera projection, and removes on close', () => {
    const container = new StubContainer();
    let panOffset = 0;
    const map = {
      getContainer: () => container,
      project: ([lon, lat]: [number, number]) => ({ x: (lon + 180) * 2 + panOffset, y: (90 - lat) * 2 })
    };
    const doc = { createElement: () => new StubElement() } as unknown as Document;

    const marker = createPointMarker(map, doc);
    marker.show({ lat: 40.25, lon: 44.5 });
    expect(container.children).toHaveLength(1);
    const dot = container.children[0]!;
    expect(dot.className).toBe('point-marker');
    expect(dot.attributes.get('aria-hidden')).toBe('true');
    expect(dot.style).toEqual({ left: '449px', top: '99.5px' });

    panOffset = 35.24;
    marker.sync();
    expect(container.children).toHaveLength(1);
    expect(dot.style).toEqual({ left: '484.2px', top: '99.5px' });

    marker.clear();
    expect(container.children).toHaveLength(0);

    marker.show({ lat: 39, lon: 45 });
    expect(container.children).toHaveLength(1);
    marker.dispose();
    expect(container.children).toHaveLength(0);
    marker.show({ lat: 39, lon: 45 });
    expect(container.children).toHaveLength(0);
  });
});
