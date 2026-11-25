// Height anchors and the screen-coordinate transforms of a Windgram vertical scale.

export interface HeightAnchor {
  heightM: number;
  y: number;
  pressureHpa: number | null;
}

export interface WindgramScale {
  anchors: readonly HeightAnchor[];
  top: number;
  bottom: number;
  floorM: number;
  topM: number;
}

export function heightToY(view: WindgramScale, heightM: number): number {
  const anchors = view.anchors;
  if (heightM <= view.floorM) return view.bottom;
  if (heightM >= view.topM) return view.top;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (heightM <= b.heightM) return a.y + (b.y - a.y) * (heightM - a.heightM) / (b.heightM - a.heightM);
  }
  return view.top;
}

export function yToHeight(view: WindgramScale, y: number): number {
  if (y >= view.bottom) return view.floorM;
  if (y <= view.top) return view.topM;
  for (let i = 1; i < view.anchors.length; i++) {
    const a = view.anchors[i - 1], b = view.anchors[i];
    if (y >= b.y) return a.heightM + (b.heightM - a.heightM) * (a.y - y) / (a.y - b.y);
  }
  return view.topM;
}
