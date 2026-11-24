import { useEffect, useRef, useState } from 'preact/hooks';
import type { UnitSystem } from '@av/client';
import {
  CLOUD_STYLE_OPTIONS,
  RAIN_STYLE_OPTIONS,
  resolveChannelStyles,
  type CloudStyleChoice,
  type RainStyleChoice
} from '../map/channel-styles';
import { THEME_OPTIONS, themeOption, type MapTheme } from '../map/visual-theme';
import type { WindHeight, WindStatus, WindStyle } from '../wind/wind-model';
import {
  DOCK_CHANNELS,
  formatWindLevelLabel,
  readThemeInfoOpen,
  THEME_CHIP_LABELS,
  WIND_ENCODING_OPTIONS,
  writeThemeInfoOpen,
  type DockChannelKey,
  type WeatherChannelKey
} from './topbar-model';

export function ModelEmblem({ isAuto }: { isAuto: boolean }) {
  if (isAuto) {
    return (
      <svg
        class="model-emblem model-emblem-auto"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="13" r="6.8" />
        <path d="M10.5 3.8v2.4M10.5 19.8v2.2M1.5 13h2.2M17.3 13h2.2" />
        <circle cx="10.5" cy="13" r="1.8" fill="currentColor" stroke="none" />
        <path
          d="m18.5 2.4.95 2.35L21.8 5.7l-2.35.95-.95 2.35-.95-2.35L15.2 5.7l2.35-.95Z"
          fill="currentColor"
          stroke="none"
        />
      </svg>
    );
  }
  return (
    <svg class="model-emblem" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M2 24 11 8l5 8 5-12 9 20M2 29h28" />
    </svg>
  );
}

function ThemeGlyph({ theme }: { theme: MapTheme }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    'aria-hidden': true
  };
  switch (theme) {
    case 'stone':
      return (
        <svg {...common}>
          <circle cx="17.5" cy="6.5" r="2.6" />
          <path d="M2.5 19.5 9.2 9.5l4.1 5.3 3-3.8 5.2 8.5Z" />
        </svg>
      );
    case 'slate':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4" stroke-dasharray="2.5 2.5" />
          <path d="M12 12 18 6.5" />
          <circle cx="15.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="13" rx="9.2" ry="6.4" />
          <ellipse cx="12.4" cy="12.6" rx="5.8" ry="3.8" />
          <ellipse cx="12.8" cy="12.2" rx="2.4" ry="1.5" />
        </svg>
      );
    case 'alabaster':
      return (
        <svg {...common}>
          <path d="M3 7.5c3.5-2.8 6.5 2.8 10 0s5-2.2 8 0" />
          <path d="M3 12.5c3.5-2.8 6.5 2.8 10 0s5-2.2 8 0" />
          <path d="M3 17.5c3.5-2.8 6.5 2.8 10 0s5-2.2 8 0" />
        </svg>
      );
    case 'convergence':
      return (
        <svg {...common}>
          <path d="M4.5 14.5h15a3 3 0 0 0 .4-5.96A4.4 4.4 0 0 0 11.5 7a3.4 3.4 0 0 0-6.2 1.8A2.8 2.8 0 0 0 4.5 14.5Z" />
          <path d="M3 18.8h18" stroke-dasharray="3 2.5" />
        </svg>
      );
    case 'blueprint':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
          <path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" stroke-width="1.35" />
        </svg>
      );
    case 'cockpit':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4.3" />
          <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" />
        </svg>
      );
    case 'classic':
      return (
        <svg {...common}>
          <path d="M2.5 9.5 12 5.5l9.5 4-9.5-1.6-9.5 1.6Z" />
          <path d="M4 14.5h16M6 18h12" />
        </svg>
      );
  }
}

function ChannelGlyph({ channel, windStyle = 'trails' }: { channel: DockChannelKey; windStyle?: WindStyle }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.9,
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    'aria-hidden': true
  };
  switch (channel) {
    case 'lift':
      return (
        <svg {...common}>
          <path d="M12 19.5V4.8m0 0L8.2 8.6M12 4.8l3.8 3.8" />
          <path d="M5.8 18c1.5-2.1 1.5-4.2 0-6.3M18.2 18c-1.5-2.1-1.5-4.2 0-6.3" stroke-width="1.6" />
        </svg>
      );
    case 'wind':
      if (windStyle === 'barbs') {
        return (
          <svg {...common}>
            <circle cx="5.5" cy="17.5" r="1.7" />
            <path d="M6.8 16.2 17.8 4.8m0 0 3.7 3m-6.8 0 3 2.5" />
          </svg>
        );
      }
      if (windStyle === 'hybrid') {
        return (
          <svg {...common}>
            <path d="M3 7c3.2-2.4 5.8 2.4 9.2 0s4.8-1.8 7.3.4M3 13c2.8-2 5 1.8 8 0" />
            <path d="M13.5 18.2 19.5 9.5m0 0 2.5 2.2" />
          </svg>
        );
      }
      return (
        <svg {...common}>
          <path d="M3 7.2h12.2a2.4 2.4 0 1 0-2.1-3.5M3 12h15.2a2.4 2.4 0 1 1-2.1 3.5M3 16.8h8.8" />
        </svg>
      );
    case 'clouds':
      return (
        <svg {...common}>
          <path d="M6.4 17.8h11.1a3.8 3.8 0 0 0 .5-7.56A5.3 5.3 0 0 0 7.5 8.9a3.6 3.6 0 0 0-1.1 8.9Z" />
        </svg>
      );
    case 'rain':
      return (
        <svg {...common}>
          <path d="M6.4 13h10.9a3.3 3.3 0 0 0 .4-6.56A4.6 4.6 0 0 0 8.2 5.2 3.2 3.2 0 0 0 6.4 13Z" />
          <path d="m8.6 15.8-1.5 3.9M12.6 15.8l-1.5 3.9M16.6 15.8l-1.5 3.9" />
        </svg>
      );
    case 'isobars':
      return (
        <svg {...common}>
          <path d="M2.6 13.8C3.5 7 8.4 3.2 16 3.4c2.3.1 4.1.7 5.4 1.8" />
          <path d="M5.2 19C6.2 11.8 10.4 8.2 17.2 8.4c1.6.1 2.9.5 4 1.3" stroke-width="1.65" />
          <path d="M14.2 13.5v6.4M19.2 13.5v6.4M14.2 16.7h5" stroke-width="2.0" />
        </svg>
      );
    case 'peek':
      return (
        <svg {...common}>
          <path d="M2.2 12s3.6-6.3 9.8-6.3 9.8 6.3 9.8 6.3-3.6 6.3-9.8 6.3S2.2 12 2.2 12Z" />
          <circle cx="12" cy="12" r="2.8" />
        </svg>
      );
  }
}

export function ThemeIconPicker(props: {
  theme: MapTheme;
  onSelectTheme: (theme: MapTheme) => void;
}) {
  const [hoveredTheme, setHoveredTheme] = useState<MapTheme | null>(null);
  const [triggerHover, setTriggerHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState<boolean>(() => readThemeInfoOpen());
  const touchTileSelectRef = useRef(false);

  const activeTheme = themeOption(props.theme);
  const activeChipLabel = THEME_CHIP_LABELS[props.theme];
  const inspected = themeOption(hoveredTheme ?? props.theme);
  const themeIndex = Math.max(0, THEME_OPTIONS.findIndex(item => item.id === props.theme));

  const cycleTheme = (step: -1 | 1) => {
    const next = THEME_OPTIONS[(themeIndex + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
    if (next) props.onSelectTheme(next.id);
  };

  const toggleInfo = () => {
    setInfoOpen(prev => {
      const next = !prev;
      writeThemeInfoOpen(next);
      return next;
    });
  };

  return (
    <div
      id="theme-bar"
      class="theme-bar"
      role="group"
      aria-label="Map style and color palette"
      onPointerLeave={() => setTriggerHover(false)}
    >
      <button
        id="theme-prev"
        type="button"
        class="theme-step"
        aria-label="Previous map style"
        onClick={() => cycleTheme(-1)}
      >‹</button>

      <details
        id="theme-picker"
        onToggle={event => {
          const isOpen = (event.currentTarget as HTMLDetailsElement).open;
          setMenuOpen(isOpen);
          if (!isOpen) setHoveredTheme(null);
        }}
      >
        <summary
          id="theme-selected"
          aria-label={`Map style: ${activeTheme.label}`}
          onPointerEnter={e => { if (e.pointerType !== 'touch') setTriggerHover(true); }}
          onPointerLeave={() => setTriggerHover(false)}
          onFocus={() => setTriggerHover(true)}
          onBlur={() => setTriggerHover(false)}
        >
          <span class="theme-glyph-wrap">
            <ThemeGlyph theme={activeTheme.id} />
            <span class="theme-mini-bar" style={{ background: activeTheme.swatch }} aria-hidden="true" />
          </span>
          <span class="theme-selected-copy">
            <span class="theme-selected-eyebrow">Map</span>
            <span class="theme-selected-name">{activeChipLabel}</span>
          </span>
          <span class="theme-selected-caret" aria-hidden="true">▾</span>
        </summary>

        <div
          id="theme-menu"
          role="listbox"
          aria-label="Choose map style and lift palette"
          onPointerLeave={() => setHoveredTheme(null)}
        >
          <div class="theme-menu-head">
            <span class="theme-menu-heading">Map Style &amp; Lift Palette</span>
            <kbd class="hover-card-kbd">[ / ]</kbd>
          </div>

          <div class="theme-icon-grid">
            {THEME_OPTIONS.map(option => {
              const selected = option.id === props.theme;
              return (
                <button
                  key={option.id}
                  id={`theme-${option.id}`}
                  type="button"
                  role="option"
                  aria-label={option.label}
                  aria-selected={selected}
                  class={selected ? 'theme-tile is-selected' : 'theme-tile'}
                  onPointerEnter={() => setHoveredTheme(option.id)}
                  onFocus={() => setHoveredTheme(option.id)}
                  onPointerDown={e => { touchTileSelectRef.current = e.pointerType === 'touch'; }}
                  onClick={event => {
                    const details = (event.currentTarget as HTMLElement).closest('details');
                    const keepOpenForTouchCompare = touchTileSelectRef.current;
                    touchTileSelectRef.current = false;
                    if (details && !keepOpenForTouchCompare) details.open = false;
                    props.onSelectTheme(option.id);
                  }}
                >
                  <ThemeGlyph theme={option.id} />
                  <span class="theme-tile-name">{THEME_CHIP_LABELS[option.id]}</span>
                  <span class="theme-tile-bar" style={{ background: option.swatch }} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <div class="theme-inspector">
            <div class="theme-inspector-head">
              <span class="theme-inspector-swatch" style={{ background: inspected.swatch }} aria-hidden="true" />
              <span class="theme-inspector-title">{inspected.label}</span>
              <button
                type="button"
                class={infoOpen ? 'theme-info-toggle is-open' : 'theme-info-toggle'}
                aria-expanded={infoOpen}
                aria-label={infoOpen ? 'Collapse style details' : 'Show style details'}
                title={infoOpen ? 'Hide style details' : 'Show style details'}
                onClick={toggleInfo}
              >
                {infoOpen ? '▾' : 'ⓘ'}
              </button>
            </div>
            {infoOpen ? (
              <p class="theme-inspector-body">{inspected.summary}. Press <strong>[</strong> or <strong>]</strong> to cycle.</p>
            ) : null}
          </div>
        </div>
      </details>

      <button
        id="theme-next"
        type="button"
        class="theme-step"
        aria-label="Next map style"
        onClick={() => cycleTheme(1)}
      >›</button>

      {triggerHover && !menuOpen ? (
        <div class="topbar-hover-card" role="tooltip">
          <div class="hover-card-head">
            <span class="hover-card-title">Map Style · {activeTheme.label}</span>
            <kbd class="hover-card-kbd">[ / ]</kbd>
          </div>
          <p class="hover-card-detail">{activeTheme.summary}</p>
        </div>
      ) : null}
    </div>
  );
}

export function WeatherChannelDock(props: {
  theme: MapTheme;
  units: UnitSystem;
  cloudStyle: CloudStyleChoice;
  rainStyle: RainStyleChoice;
  windSupported: boolean;
  windVisible: boolean;
  windStyle: WindStyle;
  windPaused: boolean;
  windHeight: WindHeight;
  windStatus: WindStatus;
  liftVisible: boolean;
  cloudsVisible: boolean;
  rainVisible: boolean;
  isobarsVisible: boolean;
  peeking: boolean;
  disabled: boolean;
  onToggleChannel: (channel: WeatherChannelKey) => void;
  onPrepareChannel?: (channel: WeatherChannelKey) => void;
  onSetCloudStyle: (style: CloudStyleChoice) => void;
  onSetRainStyle: (style: RainStyleChoice) => void;
  onSetWindStyle: (style: WindStyle) => void;
  onSetWindPaused: (paused: boolean) => void;
  onSetPeeking: (peeking: boolean) => void;
}) {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [hoveredKey, setHoveredKey] = useState<DockChannelKey | null>(null);
  const [touchInspectKey, setTouchInspectKey] = useState<DockChannelKey | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchChannelHandledRef = useRef(false);

  const peekDownAtRef = useRef(0);
  const peekWasActiveRef = useRef(false);
  const peekPointerHandledRef = useRef(false);
  const peekPointerTypeRef = useRef<string>('mouse');

  const clearTouchTimer = () => {
    if (touchTimerRef.current !== null) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  };

  const clearHoverLeaveTimer = () => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
  };

  const enterChannelHover = (key: DockChannelKey) => {
    clearHoverLeaveTimer();
    setHoveredKey(key);
    if (key !== 'peek' && !props.disabled && (!channelUnderlyingOn(key) || props.peeking)) {
      props.onPrepareChannel?.(key);
    }
  };

  const scheduleHoverLeave = () => {
    clearHoverLeaveTimer();
    hoverLeaveTimerRef.current = setTimeout(() => {
      hoverLeaveTimerRef.current = null;
      setHoveredKey(null);
    }, 150);
  };

  const armTouchAutoDismiss = () => {
    clearTouchTimer();
    touchTimerRef.current = setTimeout(() => {
      touchTimerRef.current = null;
      setTouchInspectKey(null);
    }, 4200);
  };

  useEffect(() => {
    if (!touchInspectKey && !hoveredKey) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (dockRef.current && target && !dockRef.current.contains(target)) {
        clearTouchTimer();
        clearHoverLeaveTimer();
        setTouchInspectKey(null);
        setHoveredKey(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearTouchTimer();
        clearHoverLeaveTimer();
        setTouchInspectKey(null);
        setHoveredKey(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [touchInspectKey, hoveredKey]);

  useEffect(() => {
    if (!props.windSupported) {
      if (hoveredKey === 'wind') setHoveredKey(null);
      if (touchInspectKey === 'wind') {
        clearTouchTimer();
        setTouchInspectKey(null);
      }
    }
  }, [props.windSupported, hoveredKey, touchInspectKey]);

  useEffect(() => () => {
    clearTouchTimer();
    clearHoverLeaveTimer();
  }, []);

  const channelUnderlyingOn = (key: WeatherChannelKey): boolean => {
    switch (key) {
      case 'lift': return props.liftVisible;
      case 'wind': return props.windVisible;
      case 'clouds': return props.cloudsVisible;
      case 'rain': return props.rainVisible;
      case 'isobars': return props.isobarsVisible;
    }
  };

  const channelActive = (key: DockChannelKey): boolean => {
    if (key === 'peek') return props.peeking;
    if (props.peeking) return false;
    return channelUnderlyingOn(key);
  };

  const visibleLayerChannels = DOCK_CHANNELS.filter(
    (channel): channel is (typeof DOCK_CHANNELS)[number] & { readonly key: WeatherChannelKey } =>
      channel.key !== 'peek' && (channel.key !== 'wind' || props.windSupported)
  );

  const activeInfoKey = touchInspectKey ?? hoveredKey;
  const activeDesc = activeInfoKey && (activeInfoKey !== 'wind' || props.windSupported)
    ? DOCK_CHANNELS.find(c => c.key === activeInfoKey) ?? null
    : null;
  const activeIsOn = activeInfoKey ? channelActive(activeInfoKey) : false;
  const resolvedStyles = resolveChannelStyles(props.theme, { cloudStyle: props.cloudStyle, rainStyle: props.rainStyle });
  const windPausedActive = props.windVisible && props.windPaused && props.windStyle !== 'barbs';
  const windStateBadge = !activeIsOn ? 'OFF'
    : props.windStatus === 'loading' ? 'LOADING'
    : props.windStatus === 'unavailable' ? 'UNAVAILABLE'
    : windPausedActive ? 'PAUSED'
    : 'ON';

  const triggerAction = (key: DockChannelKey) => {
    if (key === 'peek') props.onSetPeeking(!props.peeking);
    else props.onToggleChannel(key);
  };

  return (
    <div
      id="weather-dock"
      ref={dockRef}
      class="weather-dock"
      onMouseEnter={clearHoverLeaveTimer}
      onMouseLeave={scheduleHoverLeave}
    >
      <div id="weather-layers" class="control-pill icon-pill" role="group" aria-label="Weather overlay layers">
        <span class="dock-group-tag" aria-hidden="true">Layers</span>
        {visibleLayerChannels.map(channel => {
          const key = channel.key;
          const isActive = channelActive(key);
          const mutedByPeek = props.peeking && channelUnderlyingOn(key);
          const isInspected = touchInspectKey === key;
          return (
            <button
              key={key}
              id={channel.id}
              type="button"
              class={`icon-channel-btn${isActive ? ' is-active' : ''}${mutedByPeek ? ' is-peek-muted' : ''}${isInspected ? ' is-inspected' : ''}`}
              aria-label={`${channel.title} (${isActive ? (key === 'wind' && windPausedActive ? 'paused' : 'on') : mutedByPeek ? 'temporarily hidden while peeking' : 'off'})`}
              aria-pressed={isActive}
              aria-busy={key === 'wind' ? (isActive && props.windStatus === 'loading') : undefined}
              disabled={props.disabled}
              onPointerEnter={e => { if (e.pointerType !== 'touch') enterChannelHover(key); }}
              onPointerLeave={e => { if (e.pointerType !== 'touch') scheduleHoverLeave(); }}
              onFocus={() => enterChannelHover(key)}
              onBlur={scheduleHoverLeave}
              onPointerDown={e => {
                if (props.disabled) return;
                if (!channelUnderlyingOn(key) || props.peeking) props.onPrepareChannel?.(key);
                if (e.pointerType === 'touch') {
                  touchChannelHandledRef.current = true;
                  if (touchInspectKey !== key) {
                    setTouchInspectKey(key);
                    armTouchAutoDismiss();
                  } else {
                    props.onToggleChannel(key);
                    armTouchAutoDismiss();
                  }
                } else {
                  touchChannelHandledRef.current = false;
                }
              }}
              onClick={() => {
                if (props.disabled) return;
                if (touchChannelHandledRef.current) {
                  touchChannelHandledRef.current = false;
                  return;
                }
                props.onToggleChannel(key);
              }}
            >
              <ChannelGlyph channel={key} windStyle={props.windStyle} />
              <span class={`channel-bar bar-${key}`} aria-hidden="true" />
              {channel.hasStyles ? <span class="channel-menu-hint" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>

      <button
        id="peek-toggle"
        type="button"
        class={`peek-icon-btn${props.peeking ? ' is-peeking' : ''}${touchInspectKey === 'peek' ? ' is-inspected' : ''}`}
        aria-label={props.peeking ? 'Restore weather overlays' : 'Peek at bare terrain'}
        aria-pressed={props.peeking}
        disabled={props.disabled}
        onPointerEnter={e => { if (e.pointerType !== 'touch') enterChannelHover('peek'); }}
        onPointerLeave={e => {
          if (e.pointerType !== 'touch') scheduleHoverLeave();
          if (peekDownAtRef.current && !peekWasActiveRef.current && performance.now() - peekDownAtRef.current >= 190) {
            peekDownAtRef.current = 0;
            props.onSetPeeking(false);
          }
        }}
        onFocus={() => enterChannelHover('peek')}
        onBlur={scheduleHoverLeave}
        onPointerDown={event => {
          if (props.disabled || event.button !== 0) return;
          peekPointerHandledRef.current = true;
          peekPointerTypeRef.current = event.pointerType || 'mouse';
          peekDownAtRef.current = performance.now();
          peekWasActiveRef.current = props.peeking;
          if (event.pointerType === 'touch' && touchInspectKey !== 'peek' && !props.peeking) {
            setTouchInspectKey('peek');
            armTouchAutoDismiss();
          }
          if (!peekWasActiveRef.current) props.onSetPeeking(true);
        }}
        onPointerUp={() => {
          if (!peekDownAtRef.current) return;
          const heldMs = performance.now() - peekDownAtRef.current;
          peekDownAtRef.current = 0;
          if (peekPointerTypeRef.current === 'touch' && heldMs < 190 && !peekWasActiveRef.current) {
            props.onSetPeeking(false);
            return;
          }
          if (peekWasActiveRef.current || heldMs >= 190) props.onSetPeeking(false);
        }}
        onPointerCancel={() => {
          if (peekDownAtRef.current && !peekWasActiveRef.current) {
            peekDownAtRef.current = 0;
            props.onSetPeeking(false);
          }
        }}
        onClick={() => {
          if (peekPointerHandledRef.current) {
            peekPointerHandledRef.current = false;
            return;
          }
          props.onSetPeeking(!props.peeking);
        }}
      >
        <ChannelGlyph channel="peek" />
      </button>

      {activeDesc ? (
        <div
          class="topbar-hover-card channel-hover-card"
          role="status"
          aria-live="polite"
          onPointerEnter={clearHoverLeaveTimer}
          onPointerLeave={scheduleHoverLeave}
        >
          <div class="hover-card-head">
            <span class="hover-card-title">{activeDesc.title}</span>
            <span class={activeIsOn ? 'hover-state-pill is-on' : 'hover-state-pill'}>
              {activeDesc.key === 'peek'
                ? (activeIsOn ? 'PEEKING' : 'READY')
                : activeDesc.key === 'wind'
                  ? windStateBadge
                  : (activeIsOn ? 'ON' : 'OFF')}
            </span>
            {activeDesc.key === 'wind' ? (
              <span class="hover-state-pill">{formatWindLevelLabel(props.windHeight, props.units)}</span>
            ) : null}
            {activeDesc.shortcut ? <kbd class="hover-card-kbd">{activeDesc.shortcut}</kbd> : null}
          </div>
          <p class="hover-card-detail">
            {activeDesc.detail(props.theme, {
              cloudStyle: props.cloudStyle,
              rainStyle: props.rainStyle,
              windStyle: props.windStyle,
              windHeight: props.windHeight,
              units: props.units
            })}
          </p>

          {activeDesc.key === 'wind' ? (
            <div class="hover-encoding-group" role="group" aria-label="Wind display style">
              {WIND_ENCODING_OPTIONS.map(opt => {
                const selected = props.windStyle === opt.id && props.windVisible;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    class={`hover-encoding-pill${selected ? ' is-selected' : ''}`}
                    aria-pressed={selected}
                    title={opt.summary}
                    onClick={() => {
                      props.onSetWindStyle(opt.id);
                      if (touchInspectKey) armTouchAutoDismiss();
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
              <button
                type="button"
                class={`hover-encoding-pill${windPausedActive ? ' is-selected' : ''}`}
                aria-pressed={windPausedActive}
                disabled={!props.windVisible || props.windStyle === 'barbs'}
                title={windPausedActive ? 'Resume particle animation' : 'Pause particle animation'}
                onClick={() => {
                  props.onSetWindPaused(!props.windPaused);
                  if (touchInspectKey) armTouchAutoDismiss();
                }}
              >
                {windPausedActive ? 'Play' : 'Pause'}
              </button>
            </div>
          ) : null}

          {activeDesc.key === 'clouds' ? (
            <div class="hover-encoding-group" role="group" aria-label="Cloud cover encoding">
              {CLOUD_STYLE_OPTIONS.map(opt => {
                const selected = props.cloudStyle === opt.id;
                const isAutoTarget = props.cloudStyle === 'auto' && opt.id === resolvedStyles.cloudStyle;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    class={`hover-encoding-pill${selected ? ' is-selected' : ''}${isAutoTarget ? ' is-auto-target' : ''}`}
                    aria-pressed={selected}
                    title={opt.summary}
                    onClick={() => {
                      props.onSetCloudStyle(opt.id);
                      if (touchInspectKey) armTouchAutoDismiss();
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {activeDesc.key === 'rain' ? (
            <div class="hover-encoding-group" role="group" aria-label="Rain boundary encoding">
              {RAIN_STYLE_OPTIONS.map(opt => {
                const selected = props.rainStyle === opt.id;
                const isAutoTarget = props.rainStyle === 'auto' && opt.id === resolvedStyles.rainStyle;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    class={`hover-encoding-pill${selected ? ' is-selected' : ''}${isAutoTarget ? ' is-auto-target' : ''}`}
                    aria-pressed={selected}
                    title={opt.summary}
                    onClick={() => {
                      props.onSetRainStyle(opt.id);
                      if (touchInspectKey) armTouchAutoDismiss();
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {touchInspectKey === activeDesc.key ? (
            <button
              type="button"
              class="hover-card-action"
              onClick={() => {
                triggerAction(activeDesc.key);
                armTouchAutoDismiss();
              }}
            >
              {activeDesc.key === 'peek'
                ? (activeIsOn ? 'Restore overlays' : 'Latch bare terrain peek')
                : (activeIsOn ? `Hide ${activeDesc.title}` : `Show ${activeDesc.title}`)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
