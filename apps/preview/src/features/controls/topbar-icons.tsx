import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { UnitSystem } from '@av/client';
import { stepTheme, THEME_OPTIONS, themeOption, type MapTheme } from '../../themes/registry';
import type { WindHeight, WindStatus, WindStyle } from '../wind/wind-model';
import { DOCK_CHANNELS, formatWindLevelLabel, PEEK_CHANNEL, WEATHER_CHANNELS, weatherChannel, type DockChannelKey, type WeatherChannelKey } from '../../layers/channels';
import { readThemeInfoOpen, WIND_ENCODING_OPTIONS, writeThemeInfoOpen } from './topbar-model';

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
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.8}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden
    >
      {themeOption(theme).glyph.map((shape, index) => h(shape.tag, { key: index, ...shape.attrs }))}
    </svg>
  );
}

function ChannelGlyph({ channel, windStyle = 'trails' }: { channel: (typeof DOCK_CHANNELS)[number]; windStyle?: WindStyle }) {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.9}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden
    >
      {(channel.styleGlyphs?.[windStyle] ?? channel.glyph).map((shape, index) => h(shape.tag, { key: index, ...shape.attrs }))}
    </svg>
  );
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
  const activeChipLabel = themeOption(props.theme).chipLabel;
  const inspected = themeOption(hoveredTheme ?? props.theme);

  const cycleTheme = (step: -1 | 1) => props.onSelectTheme(stepTheme(props.theme, step));

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

          <div class="theme-icon-grid" style={{ "--av-theme-count": THEME_OPTIONS.length }}>
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
                  <span class="theme-tile-name">{option.chipLabel}</span>
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
  windSupported: boolean;
  windVisible: boolean;
  windStyle: WindStyle;
  windPaused: boolean;
  windHeight: WindHeight;
  /** Per-layer data state; a visible layer that is loading or unavailable is marked on its button. */
  channelStatus: Partial<Record<WeatherChannelKey, WindStatus>>;
  liftVisible: boolean;
  cloudsVisible: boolean;
  rainVisible: boolean;
  isobarsVisible: boolean;
  peeking: boolean;
  disabled: boolean;
  onToggleChannel: (channel: WeatherChannelKey) => void;
  onPrepareChannel?: (channel: WeatherChannelKey) => void;
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

  const channelUnderlyingOn = (key: WeatherChannelKey): boolean => props[weatherChannel(key).visibility];

  const channelActive = (key: DockChannelKey): boolean => {
    if (key === 'peek') return props.peeking;
    if (props.peeking) return false;
    return channelUnderlyingOn(key);
  };

  const visibleLayerChannels = WEATHER_CHANNELS.filter(channel => !channel.needsWindData || props.windSupported);

  const activeInfoKey = touchInspectKey ?? hoveredKey;
  const activeDesc = activeInfoKey === 'peek' ? PEEK_CHANNEL
    : activeInfoKey ? visibleLayerChannels.find(c => c.key === activeInfoKey) ?? null
    : null;
  const activeIsOn = activeInfoKey ? channelActive(activeInfoKey) : false;
  const windPausedActive = props.windVisible && props.windPaused && props.windStyle !== 'barbs';
  const dataState = (key: DockChannelKey) => key === 'peek' ? undefined : props.channelStatus[key];
  const stateBadge = (key: DockChannelKey) => !activeIsOn ? 'OFF'
    : dataState(key) === 'loading' ? 'LOADING'
    : dataState(key) === 'unavailable' ? 'UNAVAILABLE'
    : key === 'wind' && windPausedActive ? 'PAUSED'
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
          const state = isActive ? dataState(key) : undefined, stateLabel = state === 'loading' || state === 'unavailable' ? `, ${state}` : '';
          return (
            <button
              key={key}
              id={channel.id}
              type="button"
              class={`icon-channel-btn${isActive ? ' is-active' : ''}${mutedByPeek ? ' is-peek-muted' : ''}${isInspected ? ' is-inspected' : ''}${stateLabel ? ` is-${state}` : ''}`}
              aria-label={`${channel.title} (${isActive ? (key === 'wind' && windPausedActive ? 'paused' : 'on') + stateLabel : mutedByPeek ? 'temporarily hidden while peeking' : 'off'})`}
              aria-pressed={isActive}
              aria-busy={state === 'loading' || undefined}
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
              <ChannelGlyph channel={channel} windStyle={props.windStyle} />
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
        <ChannelGlyph channel={PEEK_CHANNEL} />
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
                : stateBadge(activeDesc.key)}
            </span>
            {activeDesc.key === 'wind' ? (
              <span class="hover-state-pill">{formatWindLevelLabel(props.windHeight, props.units)}</span>
            ) : null}
            {activeDesc.shortcut ? <kbd class="hover-card-kbd">{activeDesc.shortcut}</kbd> : null}
          </div>
          <p class="hover-card-detail">
            {activeDesc.detail(props.theme, {
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
