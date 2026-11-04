import { createHash } from 'node:crypto';
import * as Path from 'node:path';
import Dockerode from 'dockerode';
import * as fs from 'fs-extra';
import type {
  DockerContainerHandler,
  Experiment,
  Hook,
  ICleanTargets,
  ITaskContext,
  ProcessHandler,
} from 'jbr';
import { ProcessHandlerComposite, secureProcessHandler } from 'jbr';
import { ResultSerializerCsv, ResultSerializerRaw } from 'sparql-benchmark-runner';
import type { IMeasurement } from './FedShopDiscoveryRunner';
import { FedShopDiscoveryRunner } from './FedShopDiscoveryRunner';
import type { IQueryInstance, IReference } from './Workload';
import { FORMS, readQueryInstances, readReference, writeQueryInstances } from './Workload';

/** Where the generated directory is mounted in the generator, Solid server and proxy containers. */
const GENERATED = '/generated';
/** The generator's CLI inside its image. */
const CLI = '/fedshop/.venv/bin/fedshop-discovery';
/** The proxy's control port inside its container. */
const CONTROL_PORT = 3999;
const CONTAINERS = {
  generator: 'fedshop-generator',
  main: 'fedshop-virtuoso',
  known: 'fedshop-virtuoso-known',
  css: 'fedshop-css',
};
/** Virtuoso's settings for both containers; NumberOfBuffers and MaxDirtyBuffers come from the parameters. */
const VIRTUOSO_ENV = [
  'SPARQL_UPDATE=false',
  'DBA_PASSWORD=dba',
  'VIRT_HTTPServer_ServerPort=8890',
  'VIRT_HTTPServer_ServerThreads=64',
  'VIRT_HTTPServer_MaxClientConnections=64',
  'VIRT_HTTPServer_MaxKeepAlives=64',
  'VIRT_HTTPServer_KeepAliveTimeout=30',
  'VIRT_SPARQL_MaxQueryCostEstimationTime=0',
  'VIRT_SPARQL_ResultSetMaxRows=0',
  'VIRT_SPARQL_MaxQueryExecutionTime=0',
  'VIRT_Parameters_MaxQueryMem=2G',
  'VIRT_Parameters_ServerThreads=100',
  'VIRT_Parameters_MaxClientConnections=100',
  'VIRT_Parameters_CheckpointInterval=0',
  'VIRT_Parameters_DefaultIsolation=1',
];

/**
 * An experiment instance for the discovery-based FedShop benchmark.
 *
 * prepare generates the benchmark with the generator image, in three phases on one Docker
 * network: the data and documents; both Virtuoso containers loading their graphs on first start;
 * the workload, selected with the analysis endpoint. run serves it (Virtuoso, the Solid server and
 * the counting proxy) and runs the queries against the engine hook, with request counts and
 * per-component CPU and memory for every execution.
 */
export class ExperimentFedShopDiscovery implements Experiment {
  public readonly generatorImage: string;
  public readonly virtuosoImage: string;
  public readonly fedshopConfig: string;
  public readonly configOverrides: string;
  public readonly queryForm: string;
  public readonly endpointUrl: string;
  public readonly proxyControlPort: number;
  public readonly proxyRequestLog: boolean;
  public readonly serverLogLevel: string;
  public readonly virtuosoBuffersMain: number;
  public readonly virtuosoBuffersKnown: number;
  public readonly readinessTimeout: number;
  public readonly queryRunnerReplication: number;
  public readonly queryRunnerWarmupRounds: number;
  public readonly queryRunnerRequestDelay: number;
  public readonly queryRunnerEndpointAvailabilityCheckTimeout: number;
  public readonly queryRunnerUrlParams: Record<string, any>;
  public readonly queryTimeoutFallback: number | undefined;
  public readonly hookSparqlEndpoint: Hook;

  private readonly dockerode = new Dockerode();

  /**
   * @param options The experiment's parameters.
   */
  public constructor(options: IExperimentFedShopDiscoveryArgs) {
    this.generatorImage = options.generatorImage;
    this.virtuosoImage = options.virtuosoImage;
    this.fedshopConfig = options.fedshopConfig;
    this.configOverrides = options.configOverrides;
    this.queryForm = options.queryForm;
    this.endpointUrl = options.endpointUrl;
    this.proxyControlPort = options.proxyControlPort;
    this.proxyRequestLog = options.proxyRequestLog;
    this.serverLogLevel = options.serverLogLevel;
    this.virtuosoBuffersMain = options.virtuosoBuffersMain;
    this.virtuosoBuffersKnown = options.virtuosoBuffersKnown;
    this.readinessTimeout = options.readinessTimeout;
    this.queryRunnerReplication = options.queryRunnerReplication;
    this.queryRunnerWarmupRounds = options.queryRunnerWarmupRounds;
    this.queryRunnerRequestDelay = options.queryRunnerRequestDelay;
    this.queryRunnerEndpointAvailabilityCheckTimeout = options.queryRunnerEndpointAvailabilityCheckTimeout;
    this.queryRunnerUrlParams = options.queryRunnerUrlParams;
    this.queryTimeoutFallback = options.queryTimeoutFallback;
    this.hookSparqlEndpoint = options.hookSparqlEndpoint;
    if (!(this.queryForm in FORMS)) {
      throw new Error(`queryForm must be one of ${Object.keys(FORMS).join(', ')}, not '${this.queryForm}'`);
    }
  }

  public async prepare(context: ITaskContext, forceOverwriteGenerated: boolean): Promise<void> {
    await this.hookSparqlEndpoint.prepare(context, forceOverwriteGenerated);
    await this.prepareImages(context);
    const generated = context.experimentPaths.generated;
    if (forceOverwriteGenerated || !await fs.pathExists(this.markerPath(context))) {
      await this.generate(context);
    } else {
      context.logger.info(`Benchmark already generated in ${generated}`);
    }
    for (const form of Object.keys(FORMS)) {
      await writeQueryInstances(generated, form);
    }
  }

  public async run(context: ITaskContext): Promise<void> {
    const generated = context.experimentPaths.generated;

    const output = context.experimentPaths.output;
    await fs.ensureDir(Path.join(output, 'logs'));

    const serving: IServingPlan = await fs.readJson(Path.join(generated, 'benchmark', 'serving.json'));

    const networkHandler = await context.docker.networkCreator.create({ Name: this.networkName(context) });
    const network = networkHandler.network.id;
    const handlers: ProcessHandler[] = [ networkHandler ];

    const closeProcess = secureProcessHandler(new ProcessHandlerComposite(handlers), context);
    try {
      const virtuoso = await this.startVirtuoso(context, network, false);
      const css = await this.startCss(context, network, serving);
      handlers.unshift(css, ...virtuoso);

      // The engine starts before the proxy, so the proxy can measure it
      const endpoint = await this.hookSparqlEndpoint.start(context, { docker: { network } });
      handlers.unshift(endpoint);

      const proxy = await this.startProxy(context, network, serving,
        { css, main: virtuoso[0], known: virtuoso[1], engine: endpoint });
      handlers.unshift(proxy);

      // Wait for all started processes
      await this.waitForHealth(context);

      const instances = await readQueryInstances(generated, this.queryForm);
      const references = new Map<string, IReference>();
      for (const instance of instances) {
        references.set(instance.query, await readReference(generated, instance));
      }
      const measurements: IMeasurement[] = [];
      const runner = new FedShopDiscoveryRunner({
        endpoint: this.endpointUrl,
        querySets: groupByTemplate(instances),
        replication: this.queryRunnerReplication,
        warmup: this.queryRunnerWarmupRounds,
        requestDelay: this.queryRunnerRequestDelay,
        availabilityCheckTimeout: this.queryRunnerEndpointAvailabilityCheckTimeout,
        additionalUrlParams: new URLSearchParams(this.queryRunnerUrlParams),
        timeout: this.queryTimeoutFallback,
        logger: (message: string) => process.stderr.write(`${message}\n`),
        proxyControlUrl: `http://localhost:${this.proxyControlPort}`,
        instances: new Map(instances.map(instance => [ instance.query, instance ])),
        references,
        onMeasurement: measurement => measurements.push(measurement),
      });

      let stopStats: () => void = () => {
        // Stats collection has not started
      };
      const composite = new ProcessHandlerComposite(handlers);
      const results = await runner.runWithRawResults({
        async onStart() {
          stopStats = await composite.startCollectingStats();
          if (context.breakpointBarrier) {
            await context.breakpointBarrier();
          }
        },
        async onStop() {
          stopStats();
        },
      });

      context.logger.info(`Writing results to ${output}\n`);
      await new ResultSerializerCsv().serialize(Path.join(output, 'query-times.csv'), results.aggregateResults);
      if (results.rawResults) {
        await new ResultSerializerCsv().serialize(Path.join(output, 'query-executions.csv'), results.rawResults);
        await new ResultSerializerRaw().serialize(Path.join(output, 'query-results-raw.json'), results.rawResults);
      }
      await fs.writeFile(Path.join(output, 'proxy-stats.jsonl'), measurements
        .map(m => JSON.stringify({ name: m.name, id: m.id, warmup: m.warmup, proxy: m.proxy }))
        .join('\n'));
    } finally {
      await closeProcess();
    }
  }

  public async clean(context: ITaskContext, cleanTargets: ICleanTargets): Promise<void> {
    await this.hookSparqlEndpoint.clean(context, cleanTargets);
    if (cleanTargets.docker) {
      const serving = Path.join(context.experimentPaths.generated, 'benchmark', 'serving.json');
      const proxyHost = await fs.pathExists(serving) ? (await fs.readJson(serving)).proxy_host : undefined;
      for (const name of [ ...Object.values(CONTAINERS), ...proxyHost ? [ proxyHost ] : [] ]) {
        await context.docker.containerCreator.remove(name);
      }
      await context.docker.networkCreator.remove(this.networkName(context));
      for (const which of [ 'main', 'known' ]) {
        await this.dockerode.getVolume(this.volumeName(context, which)).remove().catch(() => {
          // The volume does not exist
        });
      }
    }
  }

  /**
   * Pull both images unless they are present.
   */
  private async prepareImages(context: ITaskContext): Promise<void> {
    if (!this.generatorImage) {
      throw new Error('Set generatorImage to the generator image, preferably by digest (see the README)');
    }
    for (const image of [ this.generatorImage, this.virtuosoImage ]) {
      if (!await this.imageId(image)) {
        await context.docker.imagePuller.pull({ repoTag: image });
      }
    }
  }

  /**
   * The ID of a local image, or undefined if it is not present.
   */
  private async imageId(image: string): Promise<string | undefined> {
    return await this.dockerode.getImage(image).inspect().then(info => info.Id, () => undefined);
  }

  /**
   * The three phases of generation, on one network.
   */
  private async generate(context: ITaskContext): Promise<void> {
    const generated = context.experimentPaths.generated;
    await fs.remove(this.markerPath(context));
    // From scratch: the generator reuses what it finds (WatDiv's output), whatever config made it
    for (const dir of [ 'benchmark', 'logs', 'queries' ]) {
      await fs.remove(Path.join(generated, dir));
    }
    await fs.ensureDir(Path.join(generated, 'logs'));
    await fs.copyFile(Path.resolve(context.cwd, this.configOverrides), Path.join(generated, 'overrides.yaml'));
    await fs.writeFile(Path.join(generated, 'jbr-overrides.yaml'), [
      '# Written by the jbr experiment: where outputs go and where Virtuoso runs.',
      `workdir: ${GENERATED}/benchmark`,
      'virtuoso:',
      '  external: true',
      `  host: ${CONTAINERS.main}`,
      `  known_host: ${CONTAINERS.known}`,
      '  http_port: 8890',
      '  known_http_port: 8890',
      '  wait_timeout: 7200',
      'proxy:',
      `  control_port: ${CONTROL_PORT}`,
      '',
    ].join('\n'));

    const networkHandler = await context.docker.networkCreator.create({ Name: this.networkName(context) });
    const network = networkHandler.network.id;
    try {
      context.logger.info('Generating data and documents (catalog, members, publish, fragment, load-scripts)');
      await this.runGenerator(context, 'data', [
        'catalog', 'members', 'publish', 'fragment', 'load-scripts',
      ], network);

      context.logger.info('Loading both Virtuoso containers');
      for (const which of [ 'main', 'known' ]) {
        await this.dockerode.getVolume(this.volumeName(context, which)).remove().catch(() => {
          // No database from an earlier generation
        });
      }
      const virtuoso = await this.startVirtuoso(context, network, true);
      try {
        context.logger.info('Selecting the workload (build-workload, serving-plan)');
        await this.runGenerator(context, 'workload', [
          'build-workload', `serving-plan --documents-host ${CONTAINERS.css}`,
        ], network);
      } finally {
        for (const handler of virtuoso) {
          await handler.container.stop({ t: 120 }).catch(() => {
            // Already stopped
          });
          await handler.close();
        }
      }
    } finally {
      await networkHandler.close();
    }
    await fs.writeJson(this.markerPath(context), {
      generatorImage: this.generatorImage,
      generatorImageId: await this.imageId(this.generatorImage),
      virtuosoImage: this.virtuosoImage,
      virtuosoImageId: await this.imageId(this.virtuosoImage),
      generatedAt: new Date().toISOString(),
    }, { spaces: 2 });
  }

  /**
   * Run fedshop-discovery steps in the generator image, with the overrides; fails if a step fails.
   * Files it writes are given to the user running jbr.
   */
  private async runGenerator(context: ITaskContext, label: string, steps: string[], network: string): Promise<void> {
    const generated = context.experimentPaths.generated;
    const cli = `${CLI} --overrides ${GENERATED}/overrides.yaml --overrides ${GENERATED}/jbr-overrides.yaml`;
    const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const script = [
      'set -e',
      `trap 'chown -R ${owner} ${GENERATED}' EXIT`,
      ...steps.map(step => {
        const [ command, ...options ] = step.split(' ');
        return `${cli} ${command} ${this.fedshopConfig} ${options.join(' ')}`.trim();
      }),
    ].join('\n');
    const logFilePath = Path.join(generated, 'logs', `generator-${label}.txt`);
    await context.docker.containerCreator.remove(CONTAINERS.generator);
    const handler = await context.docker.containerCreator.start({
      containerName: CONTAINERS.generator,
      imageName: this.generatorImage,
      cmdArgs: [ 'sh', '-c', script ],
      hostConfig: { Binds: [ `${generated}:${GENERATED}` ], NetworkMode: network },
      logFilePath,
    });
    const { StatusCode } = await handler.container.wait();
    // join() only removes a container whose output hasn't ended yet, which after wait() it usually has
    await handler.close();
    if (StatusCode !== 0) {
      throw new Error(`Generator step '${label}' failed with exit code ${StatusCode}, see ${logFilePath}`);
    }
  }

  // ----- serving -----

  /**
   * Both Virtuoso containers, with their database in a volume. withLoad: the volume is new, and the
   * container loads its graphs and defines its services on first start (initdb.d).
   */
  private async startVirtuoso(context: ITaskContext, network: string, withLoad: boolean): Promise<DockerContainerHandler[]> {
    const benchmark = Path.join(context.experimentPaths.generated, 'benchmark');
    const handlers: DockerContainerHandler[] = [];
    for (const [ which, buffers ] of [ [ 'main', this.virtuosoBuffersMain ], [ 'known', this.virtuosoBuffersKnown ] ] as const) {
      await context.docker.containerCreator.remove(CONTAINERS[which]);
      handlers.push(await context.docker.containerCreator.start({
        containerName: CONTAINERS[which],
        imageName: this.virtuosoImage,
        env: [
          ...VIRTUOSO_ENV,
          `VIRT_Parameters_NumberOfBuffers=${buffers}`,
          `VIRT_Parameters_MaxDirtyBuffers=${Math.round(buffers * 0.75)}`,
        ],
        hostConfig: {
          Binds: [
            `${this.volumeName(context, which)}:/database`,
            ...withLoad ?
              [
                `${Path.join(benchmark, 'data')}:/usr/share/proj:ro`,
                `${Path.join(benchmark, 'virtuoso', which, 'load.sql')}:/opt/virtuoso-opensource/initdb.d/load.sql:ro`,
              ] :
              [],
          ],
          NetworkMode: network,
        },
        logFilePath: withLoad ?
          Path.join(context.experimentPaths.generated, 'logs', `virtuoso-${which}-load.txt`) :
          Path.join(context.experimentPaths.output, 'logs', `virtuoso-${which}.txt`),
        statsFilePath: withLoad ? undefined : Path.join(context.experimentPaths.output, `stats-virtuoso-${which}.csv`),
      }));
    }
    return handlers;
  }

  private async startCss(context: ITaskContext, network: string, serving: IServingPlan): Promise<DockerContainerHandler> {
    const command = [ ...serving.css_command ];
    const level = command.indexOf('-l');
    if (level >= 0) {
      command[level + 1] = this.serverLogLevel;
    }
    await context.docker.containerCreator.remove(CONTAINERS.css);
    return await context.docker.containerCreator.start({
      containerName: CONTAINERS.css,
      imageName: this.generatorImage,
      cmdArgs: command,
      hostConfig: {
        Binds: [ `${Path.join(context.experimentPaths.generated, 'benchmark', 'web')}:${serving.web_dir}:ro` ],
        NetworkMode: network,
      },
      logFilePath: Path.join(context.experimentPaths.output, 'logs', 'css.txt'),
      statsFilePath: Path.join(context.experimentPaths.output, 'stats-css.csv'),
    });
  }

  /**
   * The counting proxy, as the host of the base URL. It measures the other containers through the
   * host's cgroups, mounted read-only: the engine too, when its hook runs it in a Docker container.
   */
  private async startProxy(
    context: ITaskContext,
    network: string,
    serving: IServingPlan,
    measured: Record<'css' | 'main' | 'known', DockerContainerHandler> & { engine: ProcessHandler },
  ): Promise<DockerContainerHandler> {
    const map = serving.proxy_map;
    map.monitor.components = [
      { name: 'engine', cgroup: await this.engineCgroup(context, measured.engine) },
      { name: 'css', cgroup: await this.cgroupOf(measured.css) },
      { name: 'known_endpoints', cgroup: await this.cgroupOf(measured.known) },
      { name: 'discovered_endpoints', cgroup: await this.cgroupOf(measured.main) },
    ].filter(c => c.cgroup);
    const mapPath = Path.join(context.experimentPaths.generated, 'proxy-run.json');
    await fs.writeJson(mapPath, map, { spaces: 1 });
    await context.docker.containerCreator.remove(serving.proxy_host);
    return await context.docker.containerCreator.start({
      containerName: serving.proxy_host,
      imageName: this.generatorImage,
      cmdArgs: [ 'node', serving.proxy_script, `${GENERATED}/proxy-run.json`,
        ...this.proxyRequestLog ? [ '/output/proxy-requests.jsonl' ] : [] ],
      hostConfig: {
        Binds: [
          `${mapPath}:${GENERATED}/proxy-run.json:ro`,
          '/sys/fs/cgroup:/host/sys/fs/cgroup:ro',
          ...this.proxyRequestLog ? [ `${context.experimentPaths.output}:/output` ] : [],
        ],
        PortBindings: { [`${CONTROL_PORT}/tcp`]: [{ HostPort: `${this.proxyControlPort}` }]},
        NetworkMode: network,
      },
      logFilePath: Path.join(context.experimentPaths.output, 'logs', 'proxy.txt'),
      statsFilePath: Path.join(context.experimentPaths.output, 'stats-proxy.csv'),
    });
  }

  /**
   * The engine's cgroup, when its hook runs it in a Docker container (as the SPARQL endpoint hooks do).
   */
  private async engineCgroup(context: ITaskContext, handler: ProcessHandler): Promise<string | undefined> {
    const container = (<Partial<DockerContainerHandler>> handler).container;
    if (!container) {
      context.logger.warn('The engine hook does not run in a Docker container: its CPU and memory are not measured');
      return undefined;
    }
    return await this.cgroupOf(<DockerContainerHandler> handler);
  }

  /**
   * A container's cgroup directory as the proxy sees it: the host's /sys/fs/cgroup is at /host/sys/fs/cgroup.
   */
  private async cgroupOf(handler: DockerContainerHandler): Promise<string> {
    const pid = (await handler.container.inspect()).State.Pid;
    const line = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find(l => l.startsWith('0::'));
    if (!line) {
      throw new Error(`No cgroup v2 entry for process ${pid}; CPU and memory per component need cgroup v2`);
    }
    return `/host/sys/fs/cgroup${line.slice(3)}`;
  }

  /**
   * Wait until the proxy reports the Solid server and both Virtuoso containers answering.
   */
  private async waitForHealth(context: ITaskContext): Promise<void> {
    const url = `http://localhost:${this.proxyControlPort}/health`;
    const start = Date.now();
    let last = '';
    while (Date.now() - start < this.readinessTimeout * 1000) {
      try {
        const response = await fetch(url);
        last = await response.text();
        if (response.ok) {
          return;
        }
      } catch (error: unknown) {
        last = (<Error> error).message;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`The servers were not ready after ${this.readinessTimeout} s: ${last}`);
  }

  // ----- names -----

  private networkName(context: ITaskContext): string {
    return context.docker.imageBuilder.getImageName(context, 'fedshop-network');
  }

  /**
   * One database volume per generated directory, so combinations that share it share the database.
   */
  private volumeName(context: ITaskContext, which: string): string {
    const hash = createHash('sha1').update(Path.resolve(context.experimentPaths.generated)).digest('hex').slice(0, 10);
    return `fedshop-discovery-${hash}-${which}`;
  }

  private markerPath(context: ITaskContext): string {
    return Path.join(context.experimentPaths.generated, 'fedshop-discovery.json');
  }
}

/**
 * serving.json, written by the generator's serving-plan step: how to serve the benchmark. Paths are
 * as seen inside the generator image.
 */
interface IServingPlan {
  base_url: string;
  /** The proxy's container name: the host of base_url. */
  proxy_host: string;
  /** The Solid server's command line. */
  css_command: string[];
  web_dir: string;
  proxy_script: string;
  /** The proxy's map, without the components it measures (the experiment adds them). */
  proxy_map: Record<string, any> & { monitor: { components: { name: string; cgroup?: string }[] } };
}

function groupByTemplate(instances: IQueryInstance[]): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const instance of instances) {
    (sets[instance.name] ||= [])[Number(instance.id)] = instance.query;
  }
  return sets;
}

export interface IExperimentFedShopDiscoveryArgs {
  /**
   * The generator image (experiments/bsbm/discovery/docker/Dockerfile-generator in FedShop), preferably
   * by digest. It also runs the Solid server and the proxy.
   */
  generatorImage: string;
  /**
   * The Virtuoso image of both query service containers, preferably by digest.
   */
  virtuosoImage: string;
  /**
   * The FedShop config inside the generator image, relative to the repository.
   */
  fedshopConfig: string;
  /**
   * The benchmark's parameters: a YAML file with keys of the config's discovery section.
   */
  configOverrides: string;
  /**
   * Which form of the queries to run: 'service' (SERVICE clauses name the known endpoints) or
   * 'plain' (no SERVICE clauses; the known endpoints are given as sources).
   */
  queryForm: string;
  /**
   * The engine's SPARQL endpoint, as reached from the host.
   */
  endpointUrl: string;
  /**
   * Host port of the proxy's control API.
   */
  proxyControlPort: number;
  /**
   * Whether the proxy writes every request to output/proxy-requests.jsonl.
   */
  proxyRequestLog: boolean;
  /**
   * Log level of the Solid server.
   */
  serverLogLevel: string;
  /**
   * Virtuoso NumberOfBuffers of the main container (every graph, the discovered services).
   */
  virtuosoBuffersMain: number;
  /**
   * Virtuoso NumberOfBuffers of the known container (the known publishers' graphs and services).
   */
  virtuosoBuffersKnown: number;
  /**
   * Seconds to wait for the servers to answer before running queries.
   */
  readinessTimeout: number;
  queryRunnerReplication: number;
  queryRunnerWarmupRounds: number;
  queryRunnerRequestDelay: number;
  queryRunnerEndpointAvailabilityCheckTimeout: number;
  /**
   * Extra parameters sent with every query.
   * @range {json}
   */
  queryRunnerUrlParams: Record<string, any>;
  /**
   * Client-side timeout per query in milliseconds.
   */
  queryTimeoutFallback?: number;
  /**
   * The engine under test, as a SPARQL endpoint.
   */
  hookSparqlEndpoint: Hook;
}
