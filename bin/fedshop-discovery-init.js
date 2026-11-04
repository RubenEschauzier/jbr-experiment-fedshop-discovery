#!/usr/bin/env node
// `jbr init fedshop-discovery <name>` for this package. jbr's init installs the experiment type
// as @jbr-experiment/<type> from npm; this package is published under another name, so the same
// init task runs here with an installer that installs this package instead. jbr finds the
// experiment type by its components, whatever the package is called.
//
// Usage: fedshop-discovery-init <directory> [--combinations] [--force]
// FEDSHOP_DISCOVERY_PACKAGE overrides what is installed (for example a local tarball: file:/path.tgz).
'use strict';
const Path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TaskInitialize, createExperimentPaths, createCliLogger } = require('jbr');
const pkg = require('../package.json');

const TYPE = 'fedshop-discovery';
const ALIAS = `@jbr-experiment/${TYPE}`;

class PackageNpmInstaller {
  async install(cwd, packages) {
    const spec = process.env.FEDSHOP_DISCOVERY_PACKAGE || `${pkg.name}@^${pkg.version}`;
    const mapped = packages.map(p => p === ALIAS ? spec : p);
    const { status, error } = spawnSync('npm', [ 'install', ...mapped ], { cwd, stdio: 'inherit' });
    if (error || status !== 0) {
      throw error || new Error(`npm install failed for ${mapped.join(', ')}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const directory = args.find(a => !a.startsWith('--'));
  if (!directory) {
    console.error('Usage: fedshop-discovery-init <directory> [--combinations] [--force]');
    process.exit(1);
  }
  const target = Path.resolve(directory);
  const context = {
    cwd: process.cwd(),
    experimentPaths: createExperimentPaths(target),
    experimentName: Path.basename(target),
    mainModulePath: target,
    verbose: false,
    logger: createCliLogger('info'),
    docker: {},
    closeExperiment: () => process.emit('SIGTERM'),
    cleanupHandlers: [],
  };
  // TaskInitialize resolves the directory against the working directory itself
  const { experimentDirectory, hookNames } = await new TaskInitialize(context, TYPE, Path.basename(target), directory,
    args.includes('--force'), args.includes('--combinations'), new PackageNpmInstaller()).init();
  console.log(`Initialized ${TYPE} experiment in ${experimentDirectory}`);
  console.log(`Set a hook next: cd ${directory} && npx jbr set-hook ${hookNames[0]} sparql-endpoint-comunica`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
