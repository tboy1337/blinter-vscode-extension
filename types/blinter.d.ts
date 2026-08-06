/**
 * Shared JSDoc types for Blinter JavaScript modules.
 * Referenced from extension.js and lib/*.js via import() typedefs.
 */

export interface BlinterIssue {
  id?: string;
  severity: string;
  message: string;
  code?: string;
  classification?: string;
  isCritical?: boolean;
  filePath?: string;
  line: number;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  variableName?: string;
  variableTrace?: string[];
}

export interface AnalyzeLineOptions {
  workspaceRoot?: string | null;
  defaultFile?: string;
  variableIndex?: Map<string, Array<{ file?: string; line?: number; value?: string }>>;
}

export interface SummaryGroupItem {
  id?: string;
  filePath: string;
  fileName: string;
  line: number;
  message: string;
  severity: string;
  classification?: string;
}

export interface SummaryGroup {
  id: string;
  label: string;
  items: SummaryGroupItem[];
}

export interface BlinterSpawnOptions {
  exePath: string;
  config: { get: (key: string, defaultValue?: unknown) => unknown };
  filePath: string;
  cwd?: string;
  onLine?: (line: string) => void;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null) => void;
  spawnImpl?: (
    command: string,
    args: string[],
    options: import('child_process').SpawnOptions
  ) => import('child_process').ChildProcess;
}

export interface InlineDebugAdapterOptions {
  spawn?: (
    command: string,
    args: string[],
    options: import('child_process').SpawnOptions
  ) => import('child_process').ChildProcess;
}
