import type { ModelId } from '@av/contracts/publication';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { AUTO_MODEL_ID } from '@av/client';

export interface ModelPickerProps {
  readonly model: ModelId;
  readonly emblemModel: string;
  readonly modelName: string;
  readonly offline: boolean;
  readonly fixtureModel: ModelId;
  readonly disabled: boolean;
  readonly onSelect: (model: ModelId) => void;
}

export function ModelPicker(props: ModelPickerProps) {
  const options = props.offline
    ? [{ modelId: props.fixtureModel, label: 'Synthetic fixture' }]
    : [...MODEL_OPTIONS, { modelId: AUTO_MODEL_ID, label: 'Auto' }];
  return (
    <details id="model-picker">
      <summary id="model-selected" data-model={props.emblemModel}>
        <svg class="model-emblem" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 24 11 8l5 8 5-12 9 20M8 24l5-8 6 8M2 29h28" /></svg>
        <span id="model-name">{props.modelName}</span>
      </summary>
      <div id="models" role="toolbar" aria-label="Forecast model">
        {options.map(option => (
          <button
            key={option.modelId}
            type="button"
            class={option.modelId === props.model ? 'model-button is-selected' : 'model-button'}
            value={option.modelId}
            disabled={props.disabled}
            onClick={event => {
              const details = (event.currentTarget as HTMLElement).closest('details');
              if (details) details.open = false;
              props.onSelect(option.modelId);
            }}
          >{option.label}</button>
        ))}
      </div>
    </details>
  );
}
