declare global {
  const Bun:
    | {
        file(path: string): {
          text(): Promise<string>;
          slice(start: number, end: number): {
            text(): Promise<string>;
          };
          stat(): Promise<{ size: number }>;
        };
      }
    | undefined;
}

export interface ContextGuardOptions {
  enabled?: boolean;
  orchestratorBudgetKB?: number;
  defaultBudgetKB?: number;
}

export interface ResolvedContextGuardConfig {
  enabled: boolean;
  orchestratorBudgetKB: number;
  defaultBudgetKB: number;
}
