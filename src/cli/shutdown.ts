let shutdownRef: ((code: number) => void) | null = null;
export function setShutdownRef(fn: ((code: number) => void) | null): void { shutdownRef = fn; }
export function getShutdownRef(): ((code: number) => void) | null { return shutdownRef; }
