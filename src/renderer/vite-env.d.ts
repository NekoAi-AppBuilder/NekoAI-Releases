/// <reference types="vite/client" />

interface Window {
  neko: {
    version(): Promise<string>;
    chooseProject(options?: { defaultPath?: string }): Promise<string | null>;
    getLastProjectDirectory?(): Promise<string | null>;
    projectExists(projectPath: string): Promise<boolean>;
    isInsideApplicationRoot(projectPath: string): Promise<boolean>;
    reportRendererError(payload: { type: string; message: string; filename: string; lineno: number; colno: number; stack: string }): Promise<void>;
    createProject(path: string): Promise<any>;
    status(): Promise<any>;
    prompt(sessionId: string, text: string, model?: { providerID: string; modelID: string; variant?: string }, attachments?: any[], contextPaths?: string[], planMode?: boolean, effort?: string, perf?: { t0?: number; prepMs?: number }): Promise<any>;
    messages(sessionId: string): Promise<any[]>;
    stop(): Promise<boolean>;
    abort(sessionId: string): Promise<boolean>;
    permissions(sessionId: string): Promise<any[]>;
    permissionReply(sessionId: string, permissionId: string, response: "once" | "always" | "reject", remember?: boolean): Promise<boolean>;
    questionReply(sessionId: string, requestId: string, answers: string[] | string[][]): Promise<boolean>;
    questionReject(sessionId: string, requestId: string): Promise<boolean>;
    tree(): Promise<any[]>;
    refresh(): Promise<any>;
    readFile(path: string): Promise<{ path: string; content: string }>;
    checkpointTask(): Promise<{ id: string } | null>;
    undoTask(taskId: string): Promise<boolean>;
    models(): Promise<{ models: any[]; defaults: Record<string,string> }>;
    providers(): Promise<{ providers: any[]; models: any[]; managedModels?: any[]; defaults: Record<string,string> }>;
    setModelEnabled(providerID: string, modelID: string, enabled: boolean): Promise<{ providers: any[]; models: any[]; managedModels?: any[] }>;
    setProviderEnabled(providerID: string, enabled: boolean): Promise<any>;
    connectProvider(providerID: string, key: string): Promise<{ ok: boolean }>;
    disconnectProvider(providerID: string): Promise<{ ok: boolean }>;
    pickAttachments(): Promise<any>;
    saveClipboardImage(dataUrl: string, mime: string): Promise<any>;
    attachmentsFromPaths(paths: string[]): Promise<any>;
    searchProject(query: string): Promise<any[]>;
    commands(): Promise<any[]>;
    runCommand(sessionId: string, command: string, args: string, model?: { providerID: string; modelID: string }): Promise<any>;
    startPreview(): Promise<any>;
    stopPreview(): Promise<boolean>;
    refreshPreview(): Promise<{ ok: boolean; method?: string; reason?: string }>;
    previewRoutes(opts?: { force?: boolean }): Promise<{ routes: { path: string; label: string }[]; projectPath: string }>;
    previewNavigate(routePath: string): Promise<{ ok: boolean; target: string; method?: string }>;
    setInternalPreviewOverlay(active: boolean): Promise<{ ok: boolean; visible?: boolean }>;
    siteCloneAnalyze(url: string, limits?: { maxPages?: number; maxDepth?: number; concurrency?: number; pageTimeoutMs?: number; maxPageBytes?: number; crawlTimeoutMs?: number }): Promise<any>;
    siteCloneCapture(url: string): Promise<any>;
    siteCloneImportAssets(assets: { url: string; kind: string }[]): Promise<{ ok: boolean; imported: { remoteUrl: string; localPath: string }[]; failed: string[]; skipped: string[] }>;
    siteCloneCancel(): Promise<{ ok: boolean }>;
    onSiteCloneEvent(callback: (event: any) => void): () => void;
    stylePreviewFrame(): Promise<boolean>;
    syncInternalPreview(payload: { session: number; url: string; visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }): Promise<{ enabled: boolean; state: string }>;
    openPreviewExternal(url: string): Promise<boolean>;
    validateBuild(): Promise<{ ok: boolean; skipped: boolean; message: string; output: string }>;
    onEvent(callback: (event: any) => void): () => void;
    onPreviewEvent(callback: (event: any) => void): () => void;
    githubStatus(refresh?: boolean): Promise<any>;
    githubStart(forceReauthorize?: boolean): Promise<any>;
    githubCancel(): Promise<{ ok: boolean }>;
    githubDisconnect(): Promise<boolean>;
    githubOpen(url: string): Promise<boolean>;
    githubGitStatus(): Promise<any>;
    githubListBranches(repoFullName: string): Promise<string[]>;
    githubCheckoutBranch(branchName: string): Promise<any>;
    githubLinkProject(repoFullName: string, replaceRemote?: boolean, overwriteLocalContent?: boolean): Promise<any>;
    githubChooseCloneDestination(): Promise<any>;
    githubOpenFolder(folderPath: string): Promise<boolean>;
    githubCloneProject(repoFullName: string, parentPath?: string, projectName?: string): Promise<any>;
    githubPublishProject(repoName: string, isPrivate?: boolean): Promise<any>;
    githubCancelPublish?(): Promise<any>;
    githubCommitPush(message: string): Promise<any>;
    onGithubEvent(callback: (event: any) => void): () => void;
    githubDiscardChanges(): Promise<boolean>;
    supabaseGetState(): Promise<any>;
    supabaseConnectWithToken(token: string): Promise<any>;
    supabaseRefreshProjects(clearNotice?: boolean): Promise<any>;
    supabaseCreateProject(payload: { name: string; orgId: string; dbPassword: string; region: string }): Promise<any>;
    supabaseSelectProject(ref: string): Promise<any>;
    supabaseDisconnect(): Promise<any>;
    supabaseOpenTokenPage(): Promise<{ success: boolean }>;
    onSupabaseStateChange(callback: (state: any) => void): () => void;
    vercelGetState(): Promise<any>;
    vercelConnect(): Promise<any>;
    vercelDisconnect(): Promise<any>;
    vercelPublish(projectName?: string): Promise<any>;
    vercelOpenDeployment(): Promise<{ success: boolean }>;
    vercelOpenDashboard(): Promise<{ success: boolean }>;
    onVercelStateChange(callback: (state: any) => void): () => void;
    onVercelLog(callback: (message: string) => void): () => void;
    licenseGetState(): Promise<{
      state: "MISSING" | "INVALID" | "VALID" | "GRACE" | "EXPIRED";
      isLicensed: boolean;
      plan?: string;
      status?: string;
      expiresAt?: string;
      graceUntil?: string;
      entitlements: string[];
      keyMask?: string;
      deviceId: string;
      licenseId?: string;
      userId?: string;
      reason?: "LOCAL_DEACTIVATION" | "REMOTE_TRANSFER" | "INITIAL_CHECK" | "VERIFIED" | string;
    }>;
    licenseActivate(licenseKey: string): Promise<{
      ok: boolean;
      grant?: string;
      expires_at?: string;
      plan?: string;
      key_mask?: string;
      error_code?: string;
      message?: string;
    }>;
    licenseResetDevice(licenseKey: string): Promise<{
      ok: boolean;
      grant?: string;
      expires_at?: string;
      plan?: string;
      key_mask?: string;
      error_code?: string;
      message?: string;
      retry_after?: number;
    }>;
    licenseValidate(): Promise<{
      ok: boolean;
      grant?: string;
      expires_at?: string;
      plan?: string;
      key_mask?: string;
      error_code?: string;
      message?: string;
      retry_after?: number;
    }>;
    licenseDeactivate(licenseId?: string): Promise<{
      ok: boolean;
      deactivated?: boolean;
      error_code?: string;
      message?: string;
    }>;
    onLicenseStateChange(callback: (state: {
      state: "MISSING" | "INVALID" | "VALID" | "GRACE" | "EXPIRED";
      isLicensed: boolean;
      plan?: string;
      status?: string;
      expiresAt?: string;
      graceUntil?: string;
      entitlements: string[];
      keyMask?: string;
      deviceId: string;
      licenseId?: string;
      userId?: string;
      reason?: "LOCAL_DEACTIVATION" | "REMOTE_TRANSFER" | "INITIAL_CHECK" | "VERIFIED" | string;
    }) => void): () => void;
    updaterGetState(): Promise<{
      status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
      currentVersion: string;
      updateInfo: { version: string; releaseDate?: string; releaseNotes?: string | any[] } | null;
      progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
      error: string | null;
      lastCheckedAt: number | null;
    }>;
    updaterCheck(): Promise<{ ok: boolean; status: string; version?: string; error?: string }>;
    updaterDownload(): Promise<{ ok: boolean; error?: string }>;
    updaterInstall(): Promise<{ ok: boolean }>;
    onUpdaterStateChange(callback: (state: {
      status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
      currentVersion: string;
      updateInfo: { version: string; releaseDate?: string; releaseNotes?: string | any[] } | null;
      progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
      error: string | null;
      lastCheckedAt: number | null;
    }) => void): () => void;
  };
}


declare module "*.svg?raw" {
  const content: string;
  export default content;
}
