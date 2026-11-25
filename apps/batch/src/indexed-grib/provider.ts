import type { ModelDefinition } from '@av/contracts';
import type { AuxiliaryRequirements } from '@av/forecast/direct-scalars';
import type { ResolvableForecastProvider } from '../provider.js';
import { indexedSource } from './source.js';

export function createIndexedGribProvider(model: ModelDefinition, requirements?: AuxiliaryRequirements): ResolvableForecastProvider {
  const source = indexedSource(model, requirements);
  const resolveRun: NonNullable<ResolvableForecastProvider['resolveRun']> = async options => {
    const { discoverPrivateIndexedGribRun } = await import('./discover.js');
    const { run, sourcePin } = await discoverPrivateIndexedGribRun(source, options);
    return { cycle: run.cycle, sourcePin };
  };
  const scheduledAuxLevelSlots = Object.values(source.upstream.auxLevels ?? {}).reduce(
    (sum, spec) => sum + source.pressureLevels.filter(level => !spec?.products || spec.products.includes(source.levelProducts.get(level)!)).length,
    0,
  );
  return { id: model.source.configurationId, provider: source.upstream.provider,
    maxLevels: model.capabilities.maxVerticalLevels, directTargets: true,
    auxiliarySurfaceFields: Object.keys(source.upstream.auxSurface ?? {}).length,
    auxiliaryLevelFields: source.pressureLevels.length ? Math.ceil(scheduledAuxLevelSlots / source.pressureLevels.length) : 0,
    ...(source.privateR2 ? { resolveRun } : {}),
    async resolveCycle(options) {
      options.signal?.throwIfAborted();
      if (source.privateR2) return (await resolveRun(options)).cycle;
      const { validateCycle } = await import('./fields.js');
      const { admitIndexedGribRun, discoverIndexedGribRun } = await import('./discover.js');
      if (options.cycle !== undefined) return (await admitIndexedGribRun(source, validateCycle(source, options.cycle), options)).cycle;
      return validateCycle(source, (await discoverIndexedGribRun(source, options)).cycle);
    },
    async proveInputs(options) { return (await import('../input-proof.js')).proveForecastInputs(model, this, options); },
    async open(options) { return (await import('./acquire.js')).createIndexedGribAcquisitionSession(source, options); }
  };
}
