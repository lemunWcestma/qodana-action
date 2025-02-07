import * as artifact from '@actions/artifact'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as glob from '@actions/glob'
import * as tc from '@actions/tool-cache'
import {
  EXECUTABLE,
  Inputs,
  VERSION,
  getProcessArchName,
  getProcessPlatformName,
  getQodanaPullArgs,
  getQodanaScanArgs,
  getQodanaSha256,
  getQodanaSha256MismatchMessage,
  getQodanaUrl,
  sha256sum
} from '../../common/qodana'
import path from 'path'

/**
 * The context for the action.
 * @returns The action inputs.
 */
export function getInputs(): Inputs {
  return {
    args: core
      .getInput('args')
      .split(',')
      .map(arg => arg.trim()),
    resultsDir: core.getInput('results-dir'),
    cacheDir: core.getInput('cache-dir'),
    primaryCacheKey: core.getInput('primary-cache-key'),
    additionalCacheKey:
      core.getInput('additional-cache-key') ||
      core.getInput('additional-cache-hash'),
    cacheDefaultBranchOnly: core.getBooleanInput('cache-default-branch-only'),
    uploadResult: core.getBooleanInput('upload-result'),
    artifactName: core.getInput('artifact-name'),
    useCaches: core.getBooleanInput('use-caches'),
    useAnnotations: core.getBooleanInput('use-annotations'),
    prMode: core.getBooleanInput('pr-mode')
  }
}
/**
 * Runs the qodana command with the given arguments.
 * @param args docker command arguments.
 * @param prMode whether the command is run in the PR mode.
 * @returns The qodana command execution output.
 */
export async function qodana(
  prMode: boolean,
  args: string[] = []
): Promise<number> {
  if (args.length === 0) {
    const inputs = getInputs()
    args = getQodanaScanArgs(inputs.args, inputs.resultsDir, inputs.cacheDir)
    if (prMode && github.context.payload.pull_request !== undefined) {
      const pr = github.context.payload.pull_request
      args.push('--commit', `CI${pr.base.sha}`)
    }
  }
  return (
    await exec.getExecOutput(EXECUTABLE, args, {
      ignoreReturnCode: true,
      env: {
        ...process.env,
        NONINTERACTIVE: '1'
      }
    })
  ).exitCode
}

/**
 * Prepares the agent for qodana scan: install Qodana CLI and pull the linter.
 * @param args qodana arguments
 */
export async function prepareAgent(args: string[]): Promise<void> {
  const arch = getProcessArchName()
  const platform = getProcessPlatformName()
  const expectedChecksum = getQodanaSha256(arch, platform)
  const temp = await tc.downloadTool(getQodanaUrl(arch, platform))
  const actualChecksum = sha256sum(temp)
  if (expectedChecksum !== actualChecksum) {
    core.setFailed(
      getQodanaSha256MismatchMessage(expectedChecksum, actualChecksum)
    )
  }
  let extractRoot
  if (process.platform === 'win32') {
    extractRoot = await tc.extractZip(temp)
  } else {
    extractRoot = await tc.extractTar(temp)
  }
  core.addPath(await tc.cacheDir(extractRoot, EXECUTABLE, VERSION))
  const exitCode = await qodana(false, getQodanaPullArgs(args))
  if (exitCode !== 0) {
    core.setFailed(`qodana pull failed with exit code ${exitCode}`)
    return
  }
}

/**
 * Uploads the Qodana report files from temp directory to GitHub job artifact.
 * @param resultsDir The path to upload report from.
 * @param artifactName Artifact upload name.
 * @param execute whether to execute promise or not.
 */
export async function uploadReport(
  resultsDir: string,
  artifactName: string,
  execute: boolean
): Promise<void> {
  if (!execute) {
    return
  }
  try {
    core.info('Uploading report...')
    const globber = await glob.create(`${resultsDir}/*`)
    const files = await globber.glob()
    await artifact
      .create()
      .uploadArtifact(artifactName, files, path.dirname(resultsDir), {
        continueOnError: true
      })
  } catch (error) {
    core.warning(`Failed to upload report – ${(error as Error).message}`)
  }
}

/**
 * Uploads the cache to GitHub Actions cache from the given path.
 * @param cacheDir The path to upload the cache from.
 * @param primaryKey Addition to the generated cache hash
 * @param execute whether to execute promise or not.
 */
export async function uploadCaches(
  cacheDir: string,
  primaryKey: string,
  execute: boolean
): Promise<void> {
  if (!execute) {
    return
  }
  try {
    if (isServer()) {
      core.warning(
        'Cache is not supported on GHES. See https://github.com/actions/cache/issues/505 for more details'
      )
      return
    }
    try {
      await cache.saveCache([cacheDir], primaryKey)
      core.info(`Cache saved with key ${primaryKey}`)
    } catch (error) {
      core.warning(
        `Failed to save cache with key ${primaryKey} – ${
          (error as Error).message
        }`
      )
    }
  } catch (error) {
    core.warning(`Failed to upload caches – ${(error as Error).message}`)
  }
}

/**
 * Restores the cache from GitHub Actions cache to the given path.
 * @param cacheDir The path to restore the cache to.
 * @param primaryKey The primary cache key.
 * @param additionalCacheKey The additional cache key.
 * @param execute whether to execute promise or not.
 */
export async function restoreCaches(
  cacheDir: string,
  primaryKey: string,
  additionalCacheKey: string,
  execute: boolean
): Promise<void> {
  if (!execute) {
    return
  }
  try {
    if (isServer()) {
      core.warning(
        'Cache is not supported on GHES. See https://github.com/actions/cache/issues/505 for more details'
      )
      return
    }
    const restoreKeys = [additionalCacheKey]
    try {
      const cacheKey = await cache.restoreCache(
        [cacheDir],
        primaryKey,
        restoreKeys
      )
      if (!cacheKey) {
        core.info(
          `Cache not found for input keys: ${[primaryKey, ...restoreKeys].join(
            ', '
          )}`
        )
        return
      }
      core.info(`Cache restored from key: ${cacheKey}`)
    } catch (error) {
      core.warning(
        `Failed to restore cache with key ${primaryKey} – ${
          (error as Error).message
        }`
      )
    }
  } catch (error) {
    core.warning(`Failed to download caches – ${(error as Error).message}`)
  }
}

/**
 * Check if the action is run on GHE.
 */
export function isServer(): boolean {
  const ghUrl = new URL(
    process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  )
  return ghUrl.hostname.toUpperCase() !== 'GITHUB.COM'
}

/**
 * Check if need to upload the cache.
 */
export function isNeedToUploadCache(
  useCaches: boolean,
  cacheDefaultBranchOnly: boolean
): boolean {
  if (!useCaches && cacheDefaultBranchOnly) {
    core.warning(
      'Turn on "use-cache" option to use "cache-default-branch-only"'
    )
  }

  if (useCaches && cacheDefaultBranchOnly) {
    const currentBranch = github.context.payload.ref
    const defaultBranch = github.context.payload.repository?.default_branch

    return currentBranch === defaultBranch
  }

  return useCaches
}
