# jbr experiment: discovery-based FedShop

A [jbr](https://github.com/rubensworks/jbr.js) experiment type for the discovery-based FedShop benchmark (`experiments/bsbm/discovery/README.md` in [FedShop](https://github.com/RubenEschauzier/FedShop)): a marketplace published as Linked Data, where an engine knows part of the federation up front and discovers the rest through the data.

This package doesn't contain the benchmark. It runs the benchmark's published generator image, and everything else in containers too: generation, both Virtuoso containers, the Solid server, the counting proxy and the engine. It builds no images itself: every image is given by reference, preferably by digest, so a run uses exactly the software another run used.

## Use

```bash
npx -p jbr -p @rubeneschauzier/fedshop-discovery fedshop-discovery-init my-experiment   # instead of jbr init
cd my-experiment
npx jbr set-hook hookSparqlEndpoint sparql-endpoint-comunica
# set generatorImage in jbr-experiment.json; see "Engine" below for the hook
npx jbr prepare
npx jbr run
```

`jbr init <type>` installs `@jbr-experiment/<type>` from npm, and this package is published under another name. `fedshop-discovery-init` runs jbr's own init task with this package installed instead (jbr finds experiment types by their components, not their package name), so the result is what `jbr init` would make; `--combinations` and `--force` work as there. After that, every jbr command works as usual.

The benchmark's parameters are in `input/discovery-overrides.yaml` (the full benchmark by default), and the experiment's own parameters in `jbr-experiment.json`. Combinations can share one generated directory, and then share its data and Virtuoso databases.

## What `prepare` does

All on one Docker network, with the generated directory mounted at `/generated`:

1. **Images.** Pulls `generatorImage` and `virtuosoImage` unless they are present.
2. **Data and documents.** The generator runs `catalog`, `members`, `publish`, `fragment` and `load-scripts`.
3. **Query services.** Both Virtuoso containers start on new database volumes and load their graphs on first start, from the scripts of step 2 (`initdb.d`): the main container every publisher's graph and the discoverable publishers' services, the known container the known publishers' graphs and services.
4. **Workload.** The generator runs `build-workload` (which also writes every instance's plain form) and `serving-plan` against the running containers, then they stop. Their databases stay in Docker volumes for `run`.
5. **Query sets.** `generated/queries/service.json` and `plain.json`: every instance with its query, its sources and its reference answer.

Generation is skipped when `generated/fedshop-discovery.json` exists; it records both images and their IDs. `jbr prepare -f` regenerates from scratch: it removes `generated/benchmark`, `logs` and `queries` and the database volumes first.

## What `run` does

1. Starts both Virtuoso containers (from their volumes), the Solid server (`fedshop-css`), the engine hook and the counting proxy, on one network. The proxy's container is named after the host of `base_url` (`fedshop-proxy`), so every IRI and endpoint in the data resolves to it on the network. The proxy's control API is published on the host (`proxyControlPort`).
2. Waits until the proxy reports every server answering (`GET /health`).
3. Runs the instances of `queryForm` with sparql-benchmark-runner. Around every query it resets the proxy (`POST /reset`, with the publishers the query's `SERVICE` clauses name as known), sends the query's own context, and afterwards reads the proxy's stats and scores the rows against the reference answer.

## Engine

The engine is the `hookSparqlEndpoint` hook, a SPARQL endpoint on the experiment's network. Every query is sent with its own context (a form field `context`):

| Form | Sources |
|---|---|
| `service` | the seed documents (the documents of the query's own IRIs); the `SERVICE` clauses name the known endpoints |
| `plain` | the seed documents and the known SPARQL endpoints |

For Comunica, use a link-traversal build and set it up as SolidBench's jbr experiment does:

- `input/dockerfiles/Dockerfile-client`: `FROM comunica/query-sparql-link-traversal-solid:<version>`, `ENV COMUNICA_CONFIG=/tmp/config.json` (otherwise the image's own default config runs, whatever `config-client.json` says), and

  ```Dockerfile
  CMD [ "/bin/sh", "-c", "node --max-old-space-size=$MAX_MEMORY ./bin/http.js -c /tmp/context.json -p 3000 -t $QUERY_TIMEOUT -l $LOG_LEVEL --idp void -i -w 1 --contextOverride" ]
  ```

  `--contextOverride` makes it read each query's context; `--idp void` is needed by Solid builds, which otherwise wait for an interactive login and never start the endpoint.
- `input/config-client.json`: imports `ccqslt:config/config-solid-default.json` (context `https://linkedsoftwaredependencies.org/bundles/npm/@comunica/config-query-sparql-link-traversal/^0.0.0/components/context.jsonld`).
- `input/context-client.json`: `{ "sources": [] }`.

## Outputs (`output/`)

| File | Content |
|---|---|
| `query-times.csv` | per instance, aggregated over replications (sparql-benchmark-runner) |
| `query-executions.csv`, `query-results-raw.json` | per execution: time, result arrival times, rows, correctness, request counts, CPU and memory per component |
| `proxy-stats.jsonl` | per execution, warmups included: the proxy's full stats |
| `stats-*.csv` | jbr's Docker stats per container over the whole run |
| `proxy-requests.jsonl` | every request (only with `proxyRequestLog`) |
| `logs/` | every container's output |

Per execution:

- **Correctness:** `referenceRows`, `distinctRows`, `correctRows`, `recall`, `precision`, `complete`. Rows are compared as sets over the reference's variables, numbers normalized.
- **Requests:** `httpRequests`, `bytes`, `requestErrors`, and for `known` and `discovered` sources: `Requests`, `Documents`, `StorageRoots`, `Containers`, `Sparql` (for example `discoveredSparql`).
- **Resources:** for `engine`, `css`, `knownEndpoints`, `discoveredEndpoints` and `proxy`: `CpuSeconds` and `CpuAvg` (exact), `CpuMin`, `CpuMax`, `MemoryAvg`, `MemoryMin`, `MemoryMax` (sampled every `proxy.sample_ms`). 100% CPU is one core.

## Parameters (`jbr-experiment.json`)

| Parameter | Default | |
|---|---|---|
| `generatorImage` | required | the generator image (see "The generator image"), as `<repository>@sha256:<digest>` |
| `virtuosoImage` | `openlink/virtuoso-opensource-7@sha256:2c7453b3…` (7.2.13-alpine) | the Virtuoso image of both query service containers |
| `fedshopConfig` | `experiments/bsbm/snakefile/config.yaml` | FedShop config inside the image |
| `configOverrides` | `input/discovery-overrides.yaml` | the benchmark's parameters |
| `queryForm` | `plain` | `service` or `plain` |
| `endpointUrl` | `http://localhost:3001/sparql` | the engine's endpoint, from the host |
| `proxyControlPort` | 3999 | host port of the proxy's control API |
| `proxyRequestLog` | false | write every request to `output/proxy-requests.jsonl` |
| `virtuosoBuffersMain` / `virtuosoBuffersKnown` | 340000 / 85000 | Virtuoso's page cache per container, in 8 KB pages (≈2.7 GB / 0.7 GB); `MaxDirtyBuffers` is 3/4 of it |
| `readinessTimeout` | 600 | seconds to wait for the servers |
| `queryRunner*`, `queryTimeoutFallback` | | as in other jbr experiments |

## The generator image

The generator image holds the generator (FedShop's Python package and WatDiv), the Solid server and the proxy. It's built from a FedShop checkout with `experiments/bsbm/discovery/docker/Dockerfile-generator`, published once, and then used by digest:

```bash
# in a FedShop checkout, at the commit to publish
docker build -f experiments/bsbm/discovery/docker/Dockerfile-generator -t <registry>/fedshop-discovery-generator:<version> .
docker push <registry>/fedshop-discovery-generator:<version>
docker inspect --format '{{index .RepoDigests 0}}' <registry>/fedshop-discovery-generator:<version>
```

Set `generatorImage` to the printed `<registry>/fedshop-discovery-generator@sha256:...`. Give digests without a tag (`repository@sha256:...`, not `repository:tag@sha256:...`): jbr's pull doesn't accept both.

## Reproducibility

A digest names one exact image, so everything that runs is fixed: the generator, its Python and Node packages, WatDiv, the Solid server, the proxy and Virtuoso. Generation itself is seeded. Building the image again later can give a different image (Debian packages follow the base image's release), which is why runs use the published one.

## Requirements

Docker, and cgroup v2 for CPU and memory per component (the proxy reads the host's `/sys/fs/cgroup`, mounted read-only). The engine is measured when its hook runs it in a Docker container, as the SPARQL endpoint hooks do.

## Development

```bash
npm install && npm run build      # compiles and generates components/
```

To try a local change to the benchmark, build the generator image from your checkout and set its local name (`fedshop-discovery-generator:local`) as `generatorImage`.
