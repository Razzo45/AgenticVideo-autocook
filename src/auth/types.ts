export type AuthKind = "service" | "launch" | "dev";

export type AuthUser = {
  userId: string;
  tenantId: string | null;
  kind: AuthKind;
};

export const SESSION_COOKIE = "autocook_session";
export const JWT_AUD = "autocook";
