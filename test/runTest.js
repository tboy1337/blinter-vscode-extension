const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { runTests } = require('@vscode/test-electron');

const PREFERRED_VSCODE_VERSION = '1.125.0';

function resolveUserProfile() {
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE;
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return path.join(process.env.HOMEDRIVE, process.env.HOMEPATH);
  }
  return undefined;
}

function getLocalCachedExecutablePath(extensionDevelopmentPath) {
  return path.join(
    extensionDevelopmentPath,
    '.vscode-test',
    `vscode-win32-x64-archive-${PREFERRED_VSCODE_VERSION}`,
    'Code.exe'
  );
}

function getPreferredExecutablePath() {
  const userProfile = resolveUserProfile();
  if (!userProfile) {
    return undefined;
  }
  return path.join(
    userProfile,
    'sauce',
    'testbench',
    '.vscode-test',
    `vscode-win32-x64-archive-${PREFERRED_VSCODE_VERSION}`,
    'Code.exe'
  );
}

function assertLooksLikeVSCodeExecutable(executablePath) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(executablePath, ['--status'], { encoding: 'utf8', env, timeout: 20000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/Version:\s+Code\s+\d+\.\d+\.\d+/i.test(output)) {
    return;
  }
  if (
    result.status === 0
    || /can only be used if Code is already running/i.test(output)
  ) {
    const size = fs.statSync(executablePath).size;
    if (size > 50_000_000) {
      return;
    }
  }
  throw new Error(
    `Configured VS Code executable does not report a VS Code version: ${executablePath}`
  );
}

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    // The test runner entrypoint that bootstraps Mocha and loads tests
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

    const localExecutable = getLocalCachedExecutablePath(extensionDevelopmentPath);
    const machineExecutable = getPreferredExecutablePath();
    const cachedExecutable = [localExecutable, machineExecutable].find(
      (candidate) => typeof candidate === 'string' && fs.existsSync(candidate)
    );

    // Allow running tests against a specific VS Code build via VSCODE_VERSION.
    const vscodeVersion = process.env.VSCODE_VERSION || PREFERRED_VSCODE_VERSION;

    const runOptions = {
      extensionDevelopmentPath,
      extensionTestsPath
    };

    if (cachedExecutable) {
      try {
        assertLooksLikeVSCodeExecutable(cachedExecutable);
        runOptions.vscodeExecutablePath = cachedExecutable;
        console.log(`Using cached VS Code executable: ${cachedExecutable}`);
      } catch (validationError) {
        const message = validationError instanceof Error ? validationError.message : String(validationError);
        console.warn(`Cached VS Code executable is invalid. Falling back to download. Reason: ${message}`);
        runOptions.version = vscodeVersion;
      }
    } else {
      runOptions.version = vscodeVersion;
      console.log(`Cached VS Code not found. Downloading version: ${vscodeVersion}`);
    }

    // VS Code terminals can inherit ELECTRON_RUN_AS_NODE=1, which breaks Code.exe launches.
    runOptions.extensionTestsEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BLINTER_TEST_MODE: process.env.BLINTER_TEST_MODE || '1'
    };

    // Download VS Code only when the local executable is not available.
    await runTests(runOptions);
    console.log('VS Code integration tests finished successfully.');
  } catch (err) {
    console.error('Failed to run VS Code integration tests:', err);
    process.exit(1);
  }
}

main();
