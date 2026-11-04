import * as Path from 'node:path';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs-extra';

/**
 * The query forms, and the files of an instance that hold each form's query and reference answer.
 * - service (injected.sparql): the query's SERVICE clauses name the known endpoints; the sources
 *   are the seed documents, the documents of the query's own IRIs.
 * - plain (plain.sparql): no SERVICE clauses; the sources are the seed documents and the known
 *   endpoints, so the engine selects sources itself.
 */
export const FORMS: Record<string, { query: string; reference: string }> = {
  service: { query: 'injected.sparql', reference: 'results.csv' },
  plain: { query: 'plain.sparql', reference: 'plain-results.csv' },
};

/**
 * One query instance as the runner executes it.
 */
export interface IQueryInstance {
  /** Template, such as q07. */
  name: string;
  /** Instance number within its template. */
  id: string;
  /** The query text. */
  query: string;
  /** The Comunica context sent with the query: its sources. */
  context: Record<string, any>;
  /** Publishers the proxy counts as known for this query; undefined means the known publishers. */
  known?: string[];
  /** The reference answer, relative to the generated directory. */
  reference: string;
}

/**
 * A reference answer: its variables, and its rows as rowKey strings.
 */
export interface IReference {
  variables: string[];
  rows: Set<string>;
}

/**
 * A publisher, as publishers.json describes it (the fields used here).
 */
interface IPublisher {
  known: boolean;
  endpoint?: string;
}

/**
 * The query instances of one form (see FORMS), written by prepare to generated/queries/<form>.json.
 */
export async function writeQueryInstances(generated: string, form: string): Promise<IQueryInstance[]> {
  const files = FORMS[form];
  const benchmark = Path.join(generated, 'benchmark');
  const serving = await fs.readJson(Path.join(benchmark, 'serving.json'));
  const base: string = serving.base_url;
  const publishers: Record<string, IPublisher> = await fs.readJson(Path.join(benchmark, 'publishers.json'));
  const byEndpoint = new Map(Object.entries(publishers)
    .filter(([ , p ]) => p.endpoint)
    .map(([ name, p ]) => [ p.endpoint!, name ]));
  const knownEndpoints = Object.values(publishers)
    .filter(p => p.known && p.endpoint)
    .map(p => ({ type: 'sparql', value: p.endpoint! }));

  const instances: IQueryInstance[] = [];
  const workload = Path.join(benchmark, 'workload');
  for (const template of (await fs.readdir(workload)).filter(d => /^q\d+$/u.test(d)).sort()) {
    const dirs = (await fs.readdir(Path.join(workload, template)))
      .filter(d => d.startsWith('instance_'))
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
    for (const dir of dirs) {
      const instanceDir = Path.join(workload, template, dir);
      const query = await fs.readFile(Path.join(instanceDir, files.query), 'utf8');
      const services = [ ...query.matchAll(/SERVICE\s*<([^>]+)>/giu) ].map(m => m[1]);
      const seeds = [ ...new Set([ ...query.matchAll(/<([^>]+)>/gu) ]
        .map(m => m[1])
        .filter(iri => iri.startsWith(base))
        .map(iri => iri.split('#')[0])) ];
      instances.push({
        name: template,
        id: dir.split('_')[1],
        query,
        context: {
          sources: [ ...seeds, ...form === 'plain' ? knownEndpoints : [] ],
          lenient: true,
        },
        known: form === 'service' ?
          [ ...new Set(services.map(e => byEndpoint.get(e)).filter((n): n is string => Boolean(n))) ] :
          undefined,
        reference: Path.relative(generated, Path.join(instanceDir, files.reference)),
      });
    }
  }
  await fs.ensureDir(Path.join(generated, 'queries'));
  await fs.writeJson(Path.join(generated, 'queries', `${form}.json`), instances, { spaces: 1 });
  return instances;
}

export async function readQueryInstances(generated: string, form: string): Promise<IQueryInstance[]> {
  return await fs.readJson(Path.join(generated, 'queries', `${form}.json`));
}

/**
 * An instance's reference answer, its rows normalized as engine answers are.
 */
export async function readReference(generated: string, instance: IQueryInstance): Promise<IReference> {
  const records: string[][] = parse(await fs.readFile(Path.join(generated, instance.reference), 'utf8'), {
    relax_column_count: true,
  });
  const [ variables = [], ...rows ] = records;
  return { variables, rows: new Set(rows.map(row => rowKey(row))) };
}

/**
 * A row as a set member: normalized values, in the reference's variable order.
 */
export function rowKey(values: string[]): string {
  return JSON.stringify(values.map(value => normalize(value)));
}

/**
 * Values compare as written, except numbers, which Virtuoso's CSV and the engine may write
 * differently (8037.050 and 8037.05).
 */
export function normalize(value: string): string {
  const v = value.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(v)) {
    let [ int, frac = '' ] = v.replace(/^\+/u, '').split('.');
    const negative = int.startsWith('-');
    int = int.replace(/^-/u, '').replace(/^0+(?=\d)/u, '') || '0';
    frac = frac.replace(/0+$/u, '');
    const out = frac ? `${int}.${frac}` : int;
    return negative && out !== '0' ? `-${out}` : out;
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/u.test(v)) {
    return String(Number(v));
  }
  return v;
}
