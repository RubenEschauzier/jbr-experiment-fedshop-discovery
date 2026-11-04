import * as Path from 'node:path';
import * as fs from 'fs-extra';
import type { IExperimentPaths } from 'jbr';
import { ExperimentHandler } from 'jbr';
import { ExperimentFedShopDiscovery } from './ExperimentFedShopDiscovery';

/**
 * An experiment handler for the discovery-based FedShop benchmark.
 */
export class ExperimentHandlerFedShopDiscovery extends ExperimentHandler<ExperimentFedShopDiscovery> {
  public constructor(
    id = 'fedshop-discovery',
    experimentClassName = ExperimentFedShopDiscovery.name,
  ) {
    super(id, experimentClassName);
  }

  public getDefaultParams(_experimentPaths: IExperimentPaths): Record<string, any> {
    return {
      generatorImage: '',
      // 7.2.13-alpine
      virtuosoImage: 'openlink/virtuoso-opensource-7@sha256:2c7453b3e401bca274f46972117a18cf1965c6b30afb9b8c86cb4340c0c9ba70',
      fedshopConfig: 'experiments/bsbm/snakefile/config.yaml',
      configOverrides: 'input/discovery-overrides.yaml',
      queryForm: 'plain',
      endpointUrl: 'http://localhost:3001/sparql',
      proxyControlPort: 3999,
      proxyRequestLog: false,
      serverLogLevel: 'warn',
      virtuosoBuffersMain: 340000,
      virtuosoBuffersKnown: 85000,
      readinessTimeout: 600,
      queryRunnerReplication: 3,
      queryRunnerWarmupRounds: 1,
      queryRunnerRequestDelay: 0,
      queryRunnerEndpointAvailabilityCheckTimeout: 1000,
      queryRunnerUrlParams: {},
      queryTimeoutFallback: 300000,
    };
  }

  public getHookNames(): string[] {
    return [ 'hookSparqlEndpoint' ];
  }

  public async init(experimentPaths: IExperimentPaths, experiment: ExperimentFedShopDiscovery): Promise<void> {
    await fs.copyFile(Path.join(__dirname, 'templates', 'discovery-overrides.yaml'),
      Path.join(experimentPaths.root, experiment.configOverrides));
  }
}
