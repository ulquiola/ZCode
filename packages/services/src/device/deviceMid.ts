import { createUuid } from "@zcode/shared";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppConfigDir } from "../paths.js";

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;

interface DeviceState {
  deviceMid?: string;
}

interface DeviceStateLockOwner {
  pid: number;
  createdAt: number;
}

const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

// `telemetry-state.json` 是设备身份文件沿用至今的磁盘文件名：CLI、Desktop、远端 server 都读写同一
// 路径与字段，改名等于重置用户的设备身份，因此文件名保持不变。该文件只承载业务身份，不再驱动上报。
function resolveDeviceStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

function resolveDeviceStateLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

async function readDeviceState(homeDir?: string): Promise<DeviceState> {
  try {
    const raw = await readFile(resolveDeviceStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as DeviceState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDeviceState(state: DeviceState, homeDir?: string): Promise<void> {
  const deviceStateFile = resolveDeviceStateFile(homeDir);
  await mkdir(dirname(deviceStateFile), { recursive: true });
  await writeFile(deviceStateFile, JSON.stringify(state, null, 2), "utf-8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleDeviceStateLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readDeviceStateLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readDeviceStateLockOwner(lockFile: string): Promise<DeviceStateLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeviceStateLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

async function withDeviceStateLock<T>(
  homeDir: string | undefined,
  run: (state: DeviceState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveDeviceStateLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        // Bugfix: 旧锁文件只有一个空文件，崩溃后 5 分钟内无法判断是否为孤儿锁。
        // 新锁写入 owner pid，让后续进程能安全回收“刚残留但持有进程已退出”的锁。
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
        const state = await readDeviceState(homeDir);
        return await run(state);
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      // Bugfix: 崩溃/强退后 telemetry-state.lock 可能遗留在磁盘上，后续所有启动都会直接卡死到超时。
      // 这里按 mtime 识别明显过期的孤儿锁并自动回收，避免用户目录里一个陈旧空文件把身份写入永久锁死。
      const removedStaleLock = await removeStaleDeviceStateLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Device state lock timeout");
}

export interface EnsureDeviceMidOptions {
  homeDir?: string;
  randomUUID?: () => string;
}

function rememberDeviceMid(deviceStateFile: string, deviceMid: string): string {
  deviceMidCacheByStateFile.set(deviceStateFile, Promise.resolve(deviceMid));
  return deviceMid;
}

/** 调用方必须已持有 telemetry-state.lock；只在 state 缺失 deviceMid 时生成并写回。 */
async function ensureDeviceMidInLockedState(
  state: DeviceState,
  options: EnsureDeviceMidOptions,
): Promise<string> {
  const deviceStateFile = resolveDeviceStateFile(options.homeDir);
  if (state.deviceMid) {
    return rememberDeviceMid(deviceStateFile, state.deviceMid);
  }

  // device_mid 独立生成，不复用任何事件 ID：它表达「设备标识」，与其它业务身份字段保持同值。
  const deviceMid = (options.randomUUID ?? createUuid)();
  state.deviceMid = deviceMid;
  await writeDeviceState(state, options.homeDir);
  return rememberDeviceMid(deviceStateFile, deviceMid);
}

/**
 * 确保 telemetry-state.json 里存在 deviceMid 并返回它。
 *
 * 远端 zcode-server 所在主机没有 Desktop main 进程，过去没有任何进程会在那里写该文件；
 * buildZCodeSourceHeaders() 又只读不生成，于是远端发往 ZCode endpoint 的请求永远缺
 * X-Device-Mid，billing/balance 被服务端拒绝为 parameter error。这里把 ensure 逻辑作为
 * 独立入口，供远端 server 启动时调用：同一个文件、同一个字段、同一把锁，与同机 CLI 得到
 * 同一个设备身份。
 */
export function ensureDeviceMid(options: EnsureDeviceMidOptions = {}): Promise<string> {
  const deviceStateFile = resolveDeviceStateFile(options.homeDir);
  const cached = deviceMidCacheByStateFile.get(deviceStateFile);
  if (cached) {
    return cached;
  }

  // Bugfix: 高频业务调用之前每条都抢 telemetry-state.lock，即使 deviceMid 已经落盘也会在
  // burst 场景里把 2 秒锁等待打满。这里按 state 文件缓存 deviceMid 的读取 promise，只在首次
  // 缺失或首次读取时进入文件锁。
  const pending = withDeviceStateLock(options.homeDir, async (state) =>
    ensureDeviceMidInLockedState(state, options),
  ).catch((error) => {
    if (deviceMidCacheByStateFile.get(deviceStateFile) === pending) {
      deviceMidCacheByStateFile.delete(deviceStateFile);
    }
    throw error;
  });
  deviceMidCacheByStateFile.set(deviceStateFile, pending);
  return pending;
}
