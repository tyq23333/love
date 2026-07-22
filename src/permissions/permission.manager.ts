export interface PermissionConfig {
  allowedUserIds: string[];
  allowedTools: string[];
  workingDir: string;
}

export class PermissionManager {
  constructor(private readonly config: PermissionConfig) {}

  isUserAllowed(userId: string): boolean {
    if (this.config.allowedUserIds.length === 0) return true;
    return this.config.allowedUserIds.includes(userId);
  }

  getAllowedTools(): string[] {
    return [...this.config.allowedTools];
  }

  getWorkingDir(): string {
    return this.config.workingDir;
  }
}
