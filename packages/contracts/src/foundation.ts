export type RegisterInput = { username: string; email: string; password: string };
export type LoginInput = { username: string; password: string };
export type PublicUser = { id: string; username: string; email: string };
export type AccountView = { id: string; baseCurrency: 'INR'; cashBalance: string; cashSequence: string };
export type RegistrationResult = { user: PublicUser; account: AccountView };
export type Principal = { user: PublicUser; accountId: string; sessionId: string };
export type IssuedSession = { token: string; csrfToken: string; expiresAt: Date };
export type ApiErrorBody = { error: { code: string; message: string; fields?: Record<string, string>; requestId: string } };
