// Shared point fixtures and a minimal fake DOM element for the windgram tests.

import { type PointFrame } from '@av/client';
import { fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../tests/client-point-fixture.ts';
import { buildWindgramView, createPointForecast } from './model.ts';

export const point = { lat: 37.65, lon: -79.8 };

export function fixture(hours: readonly number[], mapFrameCount = hours.length) {
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount });
  const expectedFrames = build.manifest.frames.map(frame => frame.id);
  const url = `https://api.test/point?lat=${point.lat}&lon=${point.lon}&frame=${expectedFrames.join(',')}&layers=`;
  const sample = fixturePointSample(build, url + 'usable-lift-msl,usable-lift-agl');
  const profile = fixtureProfileResponse(build, url + 'thermal-top-msl,pbl-height-agl,thermal-velocity,sfc-temp-c,wind-gust-10m,cloud-cover-total,cloud-cover-low');
  const forecast = (frames: readonly PointFrame[]) => createPointForecast(build, point)(build.manifest.frames, new Map(frames.map(frame => [frame.id, frame])));
  const view = (frames: readonly PointFrame[], compact = false) => {
    const site = forecast(frames);
    return buildWindgramView(site, { unitSystem: 'metric', compact, timeZone: site.site.timeZone, hours: site.hours });
  };
  return { build, sample, profile, forecast, view };
}

export class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  attributes = new Map<string, string>();
  style: { cssText?: string } = {};
  textContent = '';
  innerHTML = '';
  hidden = false;
  className = '';
  id = '';
  role = '';
  ariaLabel = '';
  ariaPressed = '';
  disabled = false;
  type = '';
  value = '';
  checked = false;
  tabIndex = -1;
  clientWidth = 420;
  constructor(readonly tag: string, readonly ownerDocument?: Document) {}
  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.innerHTML = '';
    this.append(...children);
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

export function visit(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(visit)];
}
