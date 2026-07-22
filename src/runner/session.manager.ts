export interface Session {
  readonly key: string;
  sdkSessionId?: string;
  lastActiveAt: Date;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  private sessionKey(userId: string, personaName: string): string {
    return `${userId}:${personaName.toLowerCase()}`;
  }

  getOrCreate(userId: string, personaName: string): Session {
    const key = this.sessionKey(userId, personaName);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { key, lastActiveAt: new Date() });
    }
    return this.sessions.get(key)!;
  }

  setSdkSessionId(userId: string, personaName: string, sessionId: string): void {
    const session = this.getOrCreate(userId, personaName);
    session.sdkSessionId = sessionId;
    session.lastActiveAt = new Date();
  }

  clear(userId: string, personaName: string): void {
    const key = this.sessionKey(userId, personaName);
    const session = this.sessions.get(key);
    if (session) {
      session.sdkSessionId = undefined;
      session.lastActiveAt = new Date();
    }
  }

  clearAll(userId: string): void {
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${userId}:`)) {
        session.sdkSessionId = undefined;
        session.lastActiveAt = new Date();
      }
    }
  }
}
