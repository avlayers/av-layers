# `@av/windgram`

Mount a point popup with sampled map lift and the native atmospheric chart.

```ts
import { disposePointWindgram, renderPointWindgram } from '@av/windgram';

const update = renderPointWindgram(pointBody, { frames }, build, {
  point, frameId, unitSystem, totalFrames, loading, onFrame: id => selectFrame(id)
});
update(nextFrameId);
disposePointWindgram(pointBody);
```

Pass each loader progress result to `renderPointWindgram`. The lift readout uses
the sampled AGL and MSL values while the profile loads. The MSL chart shows native
levels above model ground and preserves map lift below it. The scalar chart
covers builds that publish no native profiles. The chart follows the selected
hour. CAPE and gust labels follow the pinned layer descriptors.

[`point-windgram.ts`](src/point-windgram.ts) owns the panel and its lifecycle.
[`scalar-point.ts`](src/scalar-point.ts) renders the scalar fallback.

The headless [model](src/model.ts) converts validated frames into a chart view.

Chart modules each own one concern:

- Scenes: [`windgram-view.ts`](src/windgram-view.ts) builds one day;
  [`windgram-stitched.ts`](src/windgram-stitched.ts) joins cached
  [day panels](src/windgram-stitched-panel.ts).
- Fields: [`windgram-climb.ts`](src/windgram-climb.ts) (thermal dome),
  [`windgram-clouds.ts`](src/windgram-clouds.ts) (humidity cloud decks, and the
  sky cover strip from model total cloud), and
  [`windgram-atmosphere.ts`](src/windgram-atmosphere.ts) (inversions, model ascent,
  cloud decks), contoured by [`windgram-isobands.ts`](src/windgram-isobands.ts) on `d3-contour`.
- Drawing: [`windgram-chart.ts`](src/windgram-chart.ts) writes the SVG and
  [`windgram-key.ts`](src/windgram-key.ts) the legend.
- Interaction: [`windgram-dom.ts`](src/windgram-dom.ts) mounts the chart;
  [`windgram-interaction.ts`](src/windgram-interaction.ts) handles pointer and keys;
  [`windgram-callout.ts`](src/windgram-callout.ts) registers the hover callouts.
