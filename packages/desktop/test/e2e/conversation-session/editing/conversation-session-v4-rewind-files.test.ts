// PV4-21/PV4-22：editUserQuery(workspaceMode=rewind) 的文件事务与冲突降级。
// 证据层 L3：真实 Read/Write checkpoint + 行内三按钮 + Agent preview/apply +
// same-session branch cut。冲突路径还断言 blocked 期间文件/对话/provider request 均不变。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_FEEDBACK_LIKE } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  beginFirstV4UserQueryEdit,
  clickV4EditConflictConversationOnly,
  clickV4EditWorkspaceReset,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Edit,
  waitForV4EditWorkspaceConflict,
  waitForLatestV4CommandAck,
  waitForV4Pane,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "v4-rewind-files-e2e");
const SAFE_RELATIVE_PATH = "v4-rewind-files-e2e/safe.txt";
const CONFLICT_RELATIVE_PATH = "v4-rewind-files-e2e/conflict.txt";
const SAFE_PATH = join(DEFAULT_WORKSPACE, SAFE_RELATIVE_PATH);
const CONFLICT_PATH = join(DEFAULT_WORKSPACE, CONFLICT_RELATIVE_PATH);

describe("PV4-21/PV4-22 conversation + file rewind", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PV4-21 safe checkpoint 倒序恢复文件后才提交 same-session branch", async function () {
    this.timeout(150000);
    await prepareFileCase(SAFE_PATH);

    await sendV4Prompt("E2E_V4_REWIND_FILE_SAFE 请更新 safe.txt");
    await approvePendingFileWriteIfRequired();
    await waitForV4TimelineContaining("V4_REWIND_FILE_SAFE_ORIGINAL_REPLY", 90000);
    await waitForFileContent(SAFE_PATH, "safe-after\n");
    const originalSessionId = (await getV4PaneSnapshot()).sessionId;
    // 先赞原回复，编辑重发后再赞新回复，覆盖同一行反馈按钮的开启/取消状态。
    await clickOnlyFeedbackLike();

    await waitForV4Edit();
    const rowId = await beginFirstV4UserQueryEdit("E2E_V4_REWIND_FILE_SAFE_EDITED 文件恢复后重发");
    await clickV4EditWorkspaceReset(rowId);

    const rewindAck = await waitForLatestV4CommandAck("editUserQuery", 30000).catch(
      async (error) => {
        const fileState = await readFile(SAFE_PATH, "utf8").catch(() => "<missing>");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; safe.txt=${JSON.stringify(fileState)}`,
        );
      },
    );
    expect(rewindAck.status).toBe("accepted");

    await waitForV4TimelineContaining("V4_REWIND_FILE_SAFE_EDITED_REPLY", 90000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "safe 组合 rewind 没有回到 idle", 60000);
    expect(await readFile(SAFE_PATH, "utf8")).toBe("safe-before\n");
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.sessionId).toBe(originalSessionId);
    expect(finalSnapshot.timelineText).not.toContain("V4_REWIND_FILE_SAFE_ORIGINAL_REPLY");
    expect(finalSnapshot.timelineText).not.toContain("Conversation rewind applied");
    await clickOnlyFeedbackLike();
    // 再点一次取消，覆盖取消点赞状态。
    await clickOnlyFeedbackLike(false);
  });

  it("PV4-22 external modified 先 blocked，新 commandId 降级后只裁对话", async function () {
    this.timeout(150000);
    await prepareFileCase(CONFLICT_PATH);

    await sendV4Prompt("E2E_V4_REWIND_FILE_CONFLICT 请更新 conflict.txt");
    await approvePendingFileWriteIfRequired();
    await waitForV4TimelineContaining("V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY", 90000);
    await waitForFileContent(CONFLICT_PATH, "conflict-after\n");
    await writeFile(CONFLICT_PATH, "external-wins\n", "utf8");

    const editedMarker = "E2E_V4_REWIND_FILE_CONFLICT_EDITED";
    const requestsBefore = await countUpstreamRequestsContaining(editedMarker);
    await waitForV4Edit();
    const rowId = await beginFirstV4UserQueryEdit(`${editedMarker} 只重置对话`);
    await clickV4EditWorkspaceReset(rowId);
    await waitForV4EditWorkspaceConflict(60000);

    expect(await readFile(CONFLICT_PATH, "utf8")).toBe("external-wins\n");
    expect((await getV4PaneSnapshot()).timelineText).toContain(
      "V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY",
    );
    expect(await countUpstreamRequestsContaining(editedMarker)).toBe(requestsBefore);

    await clickV4EditConflictConversationOnly();
    await waitForV4TimelineContaining("V4_REWIND_FILE_CONFLICT_EDITED_REPLY", 90000);
    expect(await readFile(CONFLICT_PATH, "utf8")).toBe("external-wins\n");
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).not.toContain("V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY");
    expect(await countUpstreamRequestsContaining(editedMarker)).toBe(requestsBefore + 1);
  });
});

async function prepareFileCase(filePath: string) {
  await rm(CASE_ROOT, { force: true, recursive: true });
  await mkdir(CASE_ROOT, { recursive: true });
  await writeFile(filePath, filePath === SAFE_PATH ? "safe-before\n" : "conflict-before\n", "utf8");
  await prepareV4ConversationE2E();
  await switchV4Mode("yolo");
}

async function waitForFileContent(filePath: string, expected: string) {
  await browser.waitUntil(
    async () => (await readFile(filePath, "utf8").catch(() => "")) === expected,
    { timeout: 60000, timeoutMsg: `${filePath} 没有收敛到期望内容` },
  );
}

async function approvePendingFileWriteIfRequired() {
  try {
    await waitForV4PermissionDialog(15000);
    expect(await approveV4Permission()).toBe(true);
  } catch {
    // yolo 模式会直接执行；不同 permission registry 状态下也可能显式请求一次授权。
  }
}

/** 时间线里此刻只有一条可反馈的回复：悬停轮尾露出操作栏后点赞（或取消），等按钮状态变化。 */
async function clickOnlyFeedbackLike(expectPressed = true) {
  const selector = `[data-testid^="${TID_V4_FEEDBACK_LIKE}-"]`;
  await browser.waitUntil(async () => (await $$(selector).length) === 1, {
    timeout: 30000,
    timeoutMsg: "时间线里应恰好有一个点赞按钮",
  });
  const button = await $(selector);
  // 操作栏平时透明，悬停所在轮才显现；先滚到视口中间再悬停，避免点到输入框上。
  await browser.execute((element) => element.scrollIntoView({ block: "center" }), button);
  await button.moveTo();
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.waitUntil(
    async () => (await button.getAttribute("aria-pressed")) === String(expectPressed),
    { timeout: 10000, timeoutMsg: `点击后点赞按钮 aria-pressed 没有变成 ${String(expectPressed)}` },
  );
}
