/**
 * 平台事实：数据目录、OpenCode 二进制的解析顺序与版本校验。
 *
 * @module dsh-opencode-sdk-bridge/platform
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
/** 版本目录名必须符合的发布形态。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** DSH home 目录，与宿主自身约定一致。 */
export function dshHome(env = process.env, home = os.homedir()) {
    return env.DSH_HOME || path.join(home, '.dsh');
}
/**
 * 插件数据目录：配置显式指定 > 环境变量 > DSH home 下的默认目录。
 * 托管运行时的 XDG 根、日志与网关信息文件都放在这里。
 */
export function dataDirectory(options = {}, env = process.env, home = os.homedir()) {
    return options.dataDir || env.OPENCODE_SDK_BRIDGE_DATA_DIR || path.join(dshHome(env, home), 'opencode-sdk-bridge');
}
/** 当前平台的 OpenCode 二进制文件名。 */
export function runtimeBinaryName(platform = process.platform) {
    return platform === 'win32' ? 'opencode.exe' : 'opencode';
}
/** 读取一个二进制的 `--version`，超时即失败。 */
export async function binaryVersion(file) {
    const { stdout } = await exec(file, ['--version'], { timeout: 15_000, windowsHide: true });
    return stdout.trim();
}
/**
 * 解析一个可用的 OpenCode 二进制。
 *
 * 顺序：显式配置 > OPENCODE_BINARY_PATH > dsh-opencode-xdbridge 已下载的托管
 * runtime 目录（按版本取最新）> 用户自有安装（~/.opencode/bin）> PATH 上的
 * `opencode`。本插件自身不下载 runtime——如果都没有，请先安装 opencode 或让
 * dsh-opencode-xdbridge 下载一次。
 */
export async function findBinary(configured, home = dshHome(), env = process.env) {
    const binary = runtimeBinaryName();
    const candidates = [];
    if (configured)
        candidates.push({ file: configured, source: 'binaryPath 配置', checkFile: true });
    if (env.OPENCODE_BINARY_PATH)
        candidates.push({ file: env.OPENCODE_BINARY_PATH, source: 'OPENCODE_BINARY_PATH', checkFile: true });
    // dsh-opencode-xdbridge 下载好的 runtime 目录：<dshHome>/opencode-xdbridge/runtime/<ver>/opencode(.exe)
    const managedRoot = path.join(home, 'opencode-xdbridge', 'runtime');
    const entries = await fs.readdir(managedRoot, { withFileTypes: true }).catch(() => []);
    const versions = entries
        .filter(entry => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const version of versions) {
        candidates.push({ file: path.join(managedRoot, version, binary), source: `xdbridge 托管 runtime ${version}`, checkFile: true });
    }
    candidates.push({ file: path.join(os.homedir(), '.opencode', 'bin', binary), source: '用户自有安装 (~/.opencode/bin)', checkFile: true });
    candidates.push({ file: 'opencode', source: 'PATH', checkFile: false });
    for (const candidate of candidates) {
        if (candidate.checkFile) {
            try {
                await fs.access(candidate.file);
            }
            catch {
                continue;
            }
        }
        try {
            const version = await binaryVersion(candidate.file);
            if (!VERSION_PATTERN.test(version))
                continue;
            return { file: candidate.file, version, source: candidate.source };
        }
        catch {
            continue;
        }
    }
    throw new Error('未找到可用的 OpenCode 二进制：请安装 opencode、配置 binaryPath / OPENCODE_BINARY_PATH，'
        + '或先用 dsh-opencode-xdbridge 下载一次官方 runtime');
}
