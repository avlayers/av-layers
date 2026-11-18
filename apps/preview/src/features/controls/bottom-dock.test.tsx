import { describe, expect, it } from 'vitest';
import type { ComponentChild, VNode } from 'preact';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import {
  DEFAULT_DOCK_VIEW,
  DOCK_VIEW_OPTIONS,
  dockViewOption,
  isDockViewId,
  legendRangeSummary,
  spectrumGradientCss
} from './bottom-dock-model';
import { BottomDock, DockViewSwitcher } from './bottom-dock';

function serializeVNode(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(serializeVNode).join('');
  const vnode = node as VNode<Record<string, unknown>>;
  if (typeof vnode.type === 'function') {
    const fn = vnode.type as (props: Record<string, unknown>) => ComponentChild;
    return serializeVNode(fn(vnode.props));
  }
  const attrs = Object.entries(vnode.props)
    .filter(([key, val]) => key !== 'children' && typeof val !== 'function' && val !== false && val !== undefined && val !== null)
    .map(([key, val]) => {
      if (val === true) return key;
      if (key === 'style' && typeof val === 'object') {
        const css = Object.entries(val as Record<string, string | number>).map(([k, v]) => `${k}:${v}`).join(';');
        return `style="${css}"`;
      }
      return `${key}="${String(val)}"`;
    })
    .join(' ');
  const tag = String(vnode.type);
  const children = serializeVNode(vnode.props.children as ComponentChild);
  return `<${tag}${attrs ? ` ${attrs}` : ''}>${children}</${tag}>`;
}

describe('bottom-dock-model', () => {
  it('validates registered dock view IDs, rejects retired classic view, and defaults to slim capsule', () => {
    expect(DEFAULT_DOCK_VIEW).toBe('capsule');
    expect(isDockViewId('capsule')).toBe(true);
    expect(isDockViewId('classic')).toBe(false);
    expect(isDockViewId('unknown')).toBe(false);
    expect(isDockViewId(null)).toBe(false);
    expect(dockViewOption('capsule').showSteppers).toBe(true);
    expect(dockViewOption('capsule').showLoupe).toBe(true);
    expect(DOCK_VIEW_OPTIONS.map(opt => opt.id)).toEqual(['capsule']);
  });

  it('formats spectrum hairline gradients and stop summaries cleanly', () => {
    expect(spectrumGradientCss([])).toBe('transparent');
    expect(spectrumGradientCss([{ color: '#112233', label: '0' }])).toBe('#112233');
    expect(spectrumGradientCss([
      { color: '#112233', label: '0' },
      { color: '#445566', label: '' },
      { color: '#778899', label: '4.5k' }
    ])).toBe('linear-gradient(90deg, #112233 0%, #445566 50%, #778899 100%)');
    expect(legendRangeSummary([
      { color: '#112233', label: '0' },
      { color: '#445566', label: '' },
      { color: '#778899', label: '4.5k' }
    ])).toBe('0–4.5k');
  });
});

describe('BottomDock pluggable capsule view', () => {
  const build = fixtureBuild();
  const baseProps = {
    build,
    layer: 'usable-lift-agl' as const,
    theme: 'stone' as const,
    liftVisible: true,
    cloudsVisible: true,
    rainVisible: true,
    isobarsVisible: true,
    units: 'metric' as const,
    reference: 'agl' as const,
    referenceHidden: false,
    disabled: false,
    opacity: 0.5,
    scaleWidth: 48,
    scaleText: '5 km',
    frameStatus: 'Selected · Full detail',
    quality: 'detail',
    windActive: true,
    overviewReady: 12,
    overviewTotal: 40,
    detailReady: 4,
    preparationLimited: false,
    selectedIndex: 2,
    frameCount: 40,
    timestamp: 'Selected · Nov 18, 12:00',
    onReference: () => {},
    onPrepareLayer: () => {},
    onOpacity: () => {},
    onOpacityStart: () => {},
    onOpacityReset: () => {},
    onSelectDockView: () => {}
  };

  it('renders Option 1 capsule view and omits the switcher when only one dock view is registered', () => {
    const html = serializeVNode(<BottomDock {...baseProps} dockView="capsule" />);
    expect(html).toContain('data-dock-view="capsule"');
    expect(html).toContain('capsule-spectrum-lip');
    expect(html).toContain('capsule-ref-flip');
    expect(html).toContain('50%');
    expect(html).toContain('id="compact-timeline"');
    expect(html).toContain('timebar-status sr-only');
    expect(html).not.toContain('dock-view-switcher');
    expect(html).not.toContain('Split ribbon');
  });

  it('renders the pluggable switcher automatically when multiple dock view options are supplied', () => {
    const html = serializeVNode(
      <DockViewSwitcher
        dockView="capsule"
        options={[
          ...DOCK_VIEW_OPTIONS,
          { ...DOCK_VIEW_OPTIONS[0]!, label: 'Future dock', shortLabel: 'Future' }
        ]}
        onSelectDockView={() => {}}
      />
    );
    expect(html).toContain('dock-view-switcher');
    expect(html).toContain('Slim capsule');
    expect(html).toContain('Future dock');
  });
});
