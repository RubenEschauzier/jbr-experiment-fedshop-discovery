import type * as RDF from '@rdfjs/types';
import type { IResult, ISparqlBenchmarkRunnerArgs } from 'sparql-benchmark-runner';
import { SparqlBenchmarkRunner } from 'sparql-benchmark-runner';
import type { IQueryInstance, IReference } from './Workload';
import { rowKey } from './Workload';

export interface IMeasurement {
  name: string;
  id: string;
  warmup: boolean;
  result: IResult;
  /** Everything the proxy reported for this execution: request counts and resources. */
  proxy: Record<string, any>;
}

export interface IFedShopDiscoveryRunnerArgs extends ISparqlBenchmarkRunnerArgs {
  /** The proxy's control API, such as http://localhost:3999. */
  proxyControlUrl: string;
  /** Every query instance, by query text. */
  instances: Map<string, IQueryInstance>;
  /** Every reference answer, by query text. */
  references: Map<string, IReference>;
  /** Called after every execution, warmups included. */
  onMeasurement: (measurement: IMeasurement) => void;
  /**
   * The proxy's resource monitors that must be idle before the next query starts.
   * Default: both Virtuoso containers, which serve every SPARQL endpoint.
   */
  idleComponents?: string[];
  /** The CPU use (100 = one core), averaged over one window, below which a component counts as idle. Default 5. */
  idleCpuPercent?: number;
  /** The window over which CPU use is averaged, in ms. Default 1000. */
  idleWindowMs?: number;
  /** How long to wait for the components to become idle before running the next query anyway, in ms. Default 600000. */
  idleMaxWaitMs?: number;
}

/**
 * Runs the workload like SparqlBenchmarkRunner, and around every query:
 * - resets the proxy with the query as label and the publishers its SERVICE clauses name as known;
 * - sends the query's own context (its sources) with the query, which the engine reads when it
 *   accepts a context per request (Comunica: --contextOverride);
 * - keeps the rows and scores them against the reference answer;
 * - adds the proxy's request counts and per-component CPU and memory to the result;
 * - waits until the SPARQL endpoints are idle before the next query starts.
 */
export class FedShopDiscoveryRunner extends SparqlBenchmarkRunner {
  private readonly proxyControlUrl: string;
  private readonly instances: Map<string, IQueryInstance>;
  private readonly references: Map<string, IReference>;
  private readonly onMeasurement: (measurement: IMeasurement) => void;
  private readonly idleComponents: string[];
  private readonly idleCpuPercent: number;
  private readonly idleWindowMs: number;
  private readonly idleMaxWaitMs: number;
  private rows: Record<string, RDF.Term>[] = [];
  private inWarmup = false;

  public constructor(args: IFedShopDiscoveryRunnerArgs) {
    super(args);
    this.proxyControlUrl = args.proxyControlUrl;
    this.instances = args.instances;
    this.references = args.references;
    this.onMeasurement = args.onMeasurement;
    this.idleComponents = args.idleComponents ?? [ 'known_endpoints', 'discovered_endpoints' ];
    this.idleCpuPercent = args.idleCpuPercent ?? 5;
    this.idleWindowMs = args.idleWindowMs ?? 1000;
    this.idleMaxWaitMs = args.idleMaxWaitMs ?? 600_000;
  }

  public override async executeAllQueries(
    replication: number,
    warmup: boolean,
    onQuery?: (queryString: string) => Promise<void>,
  ): Promise<IResult[]> {
    this.inWarmup = warmup;
    return super.executeAllQueries(replication, warmup, onQuery);
  }

  public override async executeQuery(name: string, id: string, queryString: string): Promise<IResult> {
    const instance = this.instances.get(queryString);
    if (!instance) {
      throw new Error(`Unknown query ${name}#${id}`);
    }
    await this.control('POST', '/reset', { label: `${name}#${id}`, known: instance.known });
    this.endpointFetcher.additionalUrlParams.set('context', JSON.stringify(instance.context));
    this.rows = [];

    const result = await super.executeQuery(name, id, queryString);

    const proxy = await this.control('GET', '/stats');
    Object.assign(result, this.score(queryString), flatten(proxy));
    this.onMeasurement({ name, id, warmup: this.inWarmup, result, proxy });

    await this.waitUntilIdle(`${name}#${id}`, instance.known);
    return result;
  }

  /**
   * Waits until every idle component (by default the Virtuoso containers serving the SPARQL endpoints) has used
   * less than idleCpuPercent CPU over one window. An engine that stops at its timeout, or crashes, leaves
   * the queries it sent running on the endpoints, and the next query would start against busy endpoints.
   * Done after every query rather than only after a timeout, as an engine can also stop at its timeout
   * without reporting an error, and it costs one window when the endpoints are idle already.
   * The window resets the proxy's counters, which the next query resets again before it starts.
   */
  private async waitUntilIdle(label: string, known: string[] | undefined): Promise<void> {
    const start = Date.now();
    let reported = false;
    for (;;) {
      await this.control('POST', '/reset', { label: `${label} idle check`, known });
      await new Promise(resolve => setTimeout(resolve, this.idleWindowMs));
      const { resources = {}} = await this.control('GET', '/stats');
      const busy = this.idleComponents
        .map(name => <const> [ name, resources[name]?.cpu_percent?.avg ])
        .filter(([ , cpu ]) => typeof cpu === 'number' && cpu >= this.idleCpuPercent);
      const waited = Math.round((Date.now() - start) / 1000);
      const describe = (): string => busy.map(([ name, cpu ]) => `${name} at ${cpu}% CPU`).join(', ');
      if (busy.length === 0) {
        if (reported) {
          this.log(`Endpoints idle after ${waited} s`);
        }
        return;
      }
      if (Date.now() - start >= this.idleMaxWaitMs) {
        this.log(`Endpoints still busy after ${waited} s (${describe()}), running the next query anyway`);
        return;
      }
      if (!reported) {
        this.log(`Waiting for busy endpoints before the next query (${describe()})`);
        reported = true;
      }
    }
  }

  public override bindingsToString(bindings: Record<string, RDF.Term>): string {
    this.rows.push(bindings);
    return super.bindingsToString(bindings);
  }

  /**
   * Rows compared as sets over the reference's variables: correct rows, recall, precision.
   */
  private score(queryString: string): Record<string, number | boolean> {
    const reference = this.references.get(queryString)!;
    const got = new Set(this.rows.map(row => rowKey(reference.variables.map(v => (row[v] ?? row[`?${v}`])?.value ?? ''))));
    let correct = 0;
    for (const key of got) {
      if (reference.rows.has(key)) {
        correct++;
      }
    }
    return {
      referenceRows: reference.rows.size,
      distinctRows: got.size,
      correctRows: correct,
      recall: reference.rows.size ? correct / reference.rows.size : 1,
      precision: got.size ? correct / got.size : 1,
      complete: correct === reference.rows.size,
    };
  }

  private async control(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.proxyControlUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Proxy ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
}

/**
 * The proxy's counts and resources as flat numbers, for the results CSV.
 */
export function flatten(proxy: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {
    httpRequests: proxy.total.requests,
    bytes: proxy.total.bytes,
    requestErrors: proxy.total.errors,
  };
  for (const [ group, prefix ] of [ [ 'known_sources', 'known' ], [ 'discovered_sources', 'discovered' ] ]) {
    const c = proxy[group];
    out[`${prefix}Requests`] = c.requests;
    out[`${prefix}Documents`] = c.document;
    out[`${prefix}StorageRoots`] = c['storage-root'];
    out[`${prefix}Containers`] = c.container;
    out[`${prefix}Sparql`] = c.sparql;
  }
  for (const [ component, r ] of Object.entries<any>(proxy.resources ?? {})) {
    if (r.error && r.cpu_seconds === undefined) {
      continue;
    }
    const prefix = component.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase());
    out[`${prefix}CpuSeconds`] = r.cpu_seconds;
    out[`${prefix}CpuAvg`] = r.cpu_percent.avg;
    out[`${prefix}CpuMin`] = r.cpu_percent.min;
    out[`${prefix}CpuMax`] = r.cpu_percent.max;
    out[`${prefix}MemoryAvg`] = r.memory_bytes.avg;
    out[`${prefix}MemoryMin`] = r.memory_bytes.min;
    out[`${prefix}MemoryMax`] = r.memory_bytes.max;
  }
  return out;
}
