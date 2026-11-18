import { render } from 'preact';
import { App } from './app';
import { createPreviewApp, type PreviewApp } from './app/create-preview-app';
import type { ModelId } from '@av/contracts/publication';
import './styles/app.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing element #app');

const offline = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const fixtureModel = (import.meta.env.VITE_MODEL ?? 'gfs') as ModelId;

let activeApp: PreviewApp | null = null;

try {
  const app = createPreviewApp();
  activeApp = app;
  render(<App store={app.store} commands={app.commands} offline={offline} fixtureModel={fixtureModel} />, root);
  app.start(root);
} catch (error) {
  const box = document.createElement('p');
  box.className = 'toast error';
  box.setAttribute('role', 'alert');
  box.textContent = error instanceof Error ? error.message : String(error);
  root.append(box);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeApp?.dispose();
    activeApp = null;
    render(null, root);
  });
}
