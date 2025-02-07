import * as compress from 'azure-pipelines-tasks-utility-common/compressutility'
import * as tl from 'azure-pipelines-task-lib/task'
import * as tool from 'azure-pipelines-tool-lib'
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
import path = require('path')

export function setFailed(message: string): void {
  tl.setResult(tl.TaskResult.Failed, message)
}

/**
 * The context for the task.
 * @returns The Azure DevOps Pipeline inputs.
 */
export function getInputs(): Inputs {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const home = path.join(process.env['AGENT_TEMPDIRECTORY']!!, 'qodana')
  return {
    args: (tl.getInput('args', false) || '').split(',').map(arg => arg.trim()),
    resultsDir: tl.getInput('resultsDir', false) || path.join(home, 'results'),
    cacheDir: tl.getInput('cacheDir', false) || path.join(home, 'cache'),
    uploadResult: tl.getBoolInput('uploadResult', false) || true,
    artifactName: tl.getInput('artifactName', false) || 'qodana-report',
    // Not used by the task
    additionalCacheKey: '',
    primaryCacheKey: '',
    useAnnotations: false,
    useCaches: false,
    cacheDefaultBranchOnly: false,
    prMode: false
  }
}

/**
 * Runs the qodana command with the given arguments.
 * @param args docker command arguments.
 * @returns The qodana command execution output.
 */
export async function qodana(args: string[] = []): Promise<number> {
  if (args.length === 0) {
    const inputs = getInputs()
    args = getQodanaScanArgs(inputs.args, inputs.resultsDir, inputs.cacheDir)
  }
  return tl.exec(EXECUTABLE, args, {
    ignoreReturnCode: true,
    env: {
      ...process.env,
      NONINTERACTIVE: '1'
    }
  })
}

/**
 * Prepares the agent for qodana scan: install Qodana CLI and pull the linter.
 * @param args qodana arguments
 */
export async function prepareAgent(args: string[]): Promise<void> {
  const arch = getProcessArchName()
  const platform = getProcessPlatformName()
  const expectedChecksum = getQodanaSha256(arch, platform)
  const temp = await tool.downloadTool(getQodanaUrl(arch, platform))
  const actualChecksum = sha256sum(temp)
  if (expectedChecksum !== actualChecksum) {
    setFailed(getQodanaSha256MismatchMessage(expectedChecksum, actualChecksum))
  }
  let extractRoot
  if (process.platform === 'win32') {
    extractRoot = await tool.extractZip(temp)
  } else {
    extractRoot = await tool.extractTar(temp)
  }
  tool.prependPath(await tool.cacheDir(extractRoot, EXECUTABLE, VERSION))
  const pull = await qodana(getQodanaPullArgs(args))
  if (pull !== 0) {
    setFailed("Unable to run 'qodana pull'")
  }
}

/**
 * Uploads the Qodana report files from temp directory to Azure DevOps Pipelines job artifact.
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
    const parentDir = path.dirname(resultsDir)
    const archivePath = path.join(parentDir, `${artifactName}.zip`)
    compress.createArchive(resultsDir, 'zip', archivePath)
    tl.uploadArtifact('Qodana', archivePath, artifactName)
    const qodanaSarif = path.join(parentDir, 'qodana.sarif')
    tl.cp(path.join(resultsDir, 'qodana.sarif.json'), qodanaSarif)
    tl.uploadArtifact('CodeAnalysisLogs', qodanaSarif, 'CodeAnalysisLogs')
  } catch (error) {
    tl.warning(`Failed to upload report – ${(error as Error).message}`)
  }
}
