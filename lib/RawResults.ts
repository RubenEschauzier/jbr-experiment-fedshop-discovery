import { once } from 'node:events';
import * as fs from 'fs-extra';
import type { IResult } from 'sparql-benchmark-runner';

/**
 * Writes a JSON array to a file one element at a time, so its size is not bound by the longest string
 * Node can hold (about 512 MB): ResultSerializerRaw of sparql-benchmark-runner builds the whole file as
 * one string, which the engine's adaptiveStats metadata outgrows over a full run.
 * @param path The destination file.
 * @param elements The elements of the array.
 */
export async function writeJsonArray(path: string, elements: Iterable<unknown>): Promise<void> {
  const out = fs.createWriteStream(path, { encoding: 'utf-8' });
  const closed = once(out, 'close');
  const write = async(chunk: string): Promise<void> => {
    if (!out.write(chunk)) {
      await once(out, 'drain');
    }
  };
  try {
    let separator = '[\n';
    for (const element of elements) {
      await write(separator + JSON.stringify(element));
      separator = ',\n';
    }
    await write(separator === '[\n' ? '[]\n' : '\n]\n');
  } catch (error: unknown) {
    out.destroy();
    throw error;
  }
  out.end();
  await closed;
}

/**
 * Writes the raw results of every query execution, as ResultSerializerRaw of sparql-benchmark-runner
 * does (each error as its message), but one execution at a time.
 * @param path The destination file.
 * @param results The results of every query execution.
 */
export async function writeRawResults(path: string, results: IResult[]): Promise<void> {
  await writeJsonArray(path, results.map(result => ({
    ...result,
    error: result.error?.message ?? result.error,
  })));
}
