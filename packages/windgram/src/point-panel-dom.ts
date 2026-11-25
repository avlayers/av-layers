// Builds the point windgram panel: chart host, status lines, readout, and the bottom bar controls.

import { FORECAST_DISCLAIMER } from '@av/contracts/safety';
import { elementFactory } from './panel-dom.ts';
import { POINT_VIEW_MODE_SPECS, type PointViewMode } from './point-view-mode.ts';

/** Replaces the container content with the panel and returns the nodes the controller updates. */
export function buildPointPanel(owner: Document, container: HTMLElement, idPrefix: string, supportsMultiDay: boolean) {
  const node = elementFactory(owner);
  const section = node('section', 'av-point-series av-windgram-panel');
  const time = node('p', 'av-point-time');
  const liftSummary = node('p', 'av-windgram-lift-summary');
  const profileStatus = node('p', 'av-windgram-profile-status');
  profileStatus.role = 'status';
  const incomplete = node('p', 'av-point-incomplete', 'Forecast incomplete. Some hours could not be loaded.');
  incomplete.role = 'status';
  const chartHost = node('div', 'av-windgram-host');

  const srReadout = node('p', 'windgram-readout');
  srReadout.id = `${idPrefix}-readout`;

  // Chip-free 1-line bottom bar: [ (1-Day | 3-Day) + (‹ Day/Window ›) + conditional ↺ TOL ] ... [ Key ⓘ ]
  const bar = node('div', 'av-windgram-bar');
  const navRow = node('div', 'av-windgram-nav');

  const scopeGroup = node('div', 'wg-scope-seg');
  scopeGroup.role = 'group';
  scopeGroup.ariaLabel = 'Forecast view';
  const modeButtons = new Map<PointViewMode, HTMLButtonElement>();
  for (const spec of POINT_VIEW_MODE_SPECS) {
    const btn = node('button', 'wg-scope-btn', spec.label);
    btn.type = 'button';
    btn.ariaLabel = spec.ariaLabel;
    btn.setAttribute?.('data-point-view', spec.id);
    modeButtons.set(spec.id, btn);
    scopeGroup.append(btn);
  }
  scopeGroup.hidden = !supportsMultiDay;

  const stepper = node('div', 'wg-day-stepper');
  stepper.role = 'group';
  stepper.ariaLabel = 'Forecast day navigation';
  const stepPrevBtn = node('button', 'wg-step-btn', '‹');
  stepPrevBtn.type = 'button';
  const stepLabelEl = node('span', 'wg-step-label');
  const stepNextBtn = node('button', 'wg-step-btn', '›');
  stepNextBtn.type = 'button';
  stepper.append(stepPrevBtn, stepLabelEl, stepNextBtn);

  const snapTolBtn = node('button', 'wg-chip is-alt', '↺ TOL');
  snapTolBtn.type = 'button';
  snapTolBtn.title = 'Return cursor to Top of Lift';
  snapTolBtn.hidden = true;

  navRow.append(scopeGroup, stepper, snapTolBtn);

  const keyPop = node('details', 'av-windgram-key-pop');
  keyPop.addEventListener('toggle', () => {
    if (!keyPop.open) return;
    const siblingInfo = container.parentElement?.querySelector?.<HTMLDetailsElement>('#point-settings[open]');
    if (siblingInfo) siblingInfo.open = false;
  });
  const keySummary = node('summary', 'av-windgram-key-btn');
  keySummary.ariaLabel = 'Visual chart key';
  const keyIcon = node('span', 'av-windgram-key-glyph');
  keyIcon.setAttribute?.('aria-hidden', 'true');
  keyIcon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">' +
    '<rect x="1" y="1.5" width="10" height="2.2" rx="1" fill="#38bdf8"/>' +
    '<rect x="1" y="4.9" width="10" height="2.2" rx="1" fill="#facc15"/>' +
    '<rect x="1" y="8.3" width="10" height="2.2" rx="1" fill="#f97316"/>' +
    '</svg>';
  keySummary.append(keyIcon, node('span', undefined, 'Key'));
  const keyCard = node('div', 'av-windgram-key');
  keyPop.append(keySummary, keyCard);
  bar.append(navRow, keyPop);

  section.append(chartHost, liftSummary, time, profileStatus, incomplete, srReadout, bar, node('p', 'av-windgram-disclaimer', FORECAST_DISCLAIMER));
  container.replaceChildren(section);

  return {
    section, time, liftSummary, profileStatus, incomplete, chartHost, srReadout, bar,
    modeButtons, stepper, stepPrevBtn, stepLabelEl, stepNextBtn, snapTolBtn, keyPop, keyCard,
  };
}
